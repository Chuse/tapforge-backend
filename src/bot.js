/**
 * bot.js
 * Bot de Telegram Desna — Klever Network Intelligence
 * Stack: Telegraf + node-cron + pg
 */

const { Telegraf } = require('telegraf')
const cron         = require('node-cron')
const crypto       = require('crypto')

const { collectEpochSnapshot, saveEpochSnapshot, getPreviousSnapshot } = require('./epochService')
const { buildEpochReport, buildEpochMessages }                          = require('./reportService')
const { runPersonalAlerts, getDelegationsSummary }                      = require('./alertService')
const custodialService                                                  = require('./custodialService')

// ─── Config ───────────────────────────────────────────────────────────────────

const BOT_TOKEN           = process.env.TELEGRAM_BOT_TOKEN
const PRIVATE_CHANNEL_ID  = process.env.TELEGRAM_PRIVATE_CHANNEL_ID
const ADMIN_TELEGRAM_ID   = parseInt(process.env.TELEGRAM_ADMIN_ID)
const KLV_RECEIVE_ADDRESS = process.env.KLV_RECEIVE_ADDRESS
const SUBSCRIPTION_USD    = 2

const KLEVER_API = 'https://api.mainnet.klever.org'
const COINGECKO  = 'https://api.coingecko.com/api/v3'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeMarkdown(text) {
  return String(text).replace(/[_*[\]()~`>#+=|{}.!\-]/g, '\\$&')
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function generatePaymentCode() {
  const bytes = crypto.randomBytes(4).toString('hex').toUpperCase()
  return `KLV-${bytes.slice(0, 4)}-${bytes.slice(4, 8)}`
}

async function fetchKlvPrice() {
  const res  = await fetch(`${COINGECKO}/coins/markets?vs_currency=usd&ids=klever`)
  const json = await res.json()
  return json?.[0]?.current_price ?? 0
}

async function verifyPayment(txHash, expectedCode, toAddress) {
  const res  = await fetch(`${KLEVER_API}/v1.0/transaction/${txHash}`)
  const json = await res.json()

  if (json.error || !json.data?.transaction) {
    return { valid: false, reason: 'Transacción no encontrada en la red Klever\\.', klvAmount: 0 }
  }

  const tx = json.data.transaction

  if (tx.status !== 'success') {
    return { valid: false, reason: `La transacción no está confirmada \\(status: ${escapeMarkdown(tx.status)}\\)\\.`, klvAmount: 0 }
  }

  // Verificar memo
  let memo = ''
  if (tx.data) {
    try {
      memo = Buffer.from(Array.isArray(tx.data) ? tx.data[0] : tx.data, 'hex').toString('utf8').trim()
    } catch {
      memo = String(tx.data)
    }
  }

  if (!memo.includes(expectedCode)) {
    return {
      valid:  false,
      reason: `El memo no coincide\\. Esperado: \`${escapeMarkdown(expectedCode)}\`\\.`,
      klvAmount: 0,
    }
  }

  // Verificar destinatario y asset
  const contracts = Array.isArray(tx.contract) ? tx.contract : []
  let klvAmount   = 0

  for (const c of contracts) {
    const param  = c.parameter ?? {}
    const to     = param.toAddress ?? param.receiver ?? ''
    const asset  = param.assetId ?? 'KLV'
    const amount = (param.amount ?? 0) / 1_000_000

    if (to === toAddress && asset === 'KLV') {
      klvAmount += amount
    }
  }

  if (klvAmount === 0) {
    return { valid: false, reason: 'No se encontró un pago en KLV a la dirección correcta\\.', klvAmount: 0 }
  }

  // Verificar importe mínimo con 5% de margen por volatilidad
  const klvPrice = await fetchKlvPrice()
  const minKlv   = (SUBSCRIPTION_USD / klvPrice) * 0.95

  if (klvAmount < minKlv) {
    return {
      valid:  false,
      reason: `Importe insuficiente\\. Recibido: ${klvAmount.toFixed(2)} KLV \\(mínimo: ${minKlv.toFixed(2)} KLV\\)\\.`,
      klvAmount,
    }
  }

  return { valid: true, klvAmount }
}

// ─── Alertas de validadores ───────────────────────────────────────────────────

async function sendValidatorAlerts(pool, bot, current, previous) {
  if (!previous) return

  const alerts = await pool.query('SELECT * FROM bot_validator_alerts')

  for (const alert of alerts.rows) {
    const { telegram_id, validator_address } = alert

    const sub = await pool.query(
      'SELECT active FROM bot_subscribers WHERE telegram_id = $1',
      [telegram_id]
    )
    if (!sub.rows[0]?.active) continue

    const currV = current.validatorList.find(v => v.address === validator_address)
    const prevV = previous.validatorList.find(v => v.address === validator_address)

    if (!currV) continue

    const name = escapeMarkdown(currV.name || `${validator_address.slice(0, 10)}...`)
    const msgs = []

    if (prevV?.elected && !currV.elected) {
      msgs.push(`⚠️ Tu validador *${name}* ha sido *deseleccionado* en la época ${current.epochNumber}\\.`)
    }
    if (!prevV?.jailed && currV.jailed) {
      msgs.push(`🚨 Tu validador *${name}* ha entrado en *jail* en la época ${current.epochNumber}\\.`)
    }
    if (!prevV?.elected && currV.elected) {
      msgs.push(`✅ Tu validador *${name}* ha sido *elegido* en la época ${current.epochNumber}\\.`)
    }

    for (const msg of msgs) {
      try {
        await bot.telegram.sendMessage(telegram_id, msg, { parse_mode: 'MarkdownV2' })
      } catch (err) {
        console.error(`[alerts] Error enviando alerta a ${telegram_id}:`, err.message)
      }
    }
  }
}

// ─── Helper: resumen de wallet ────────────────────────────────────────────────

function fmt(n, decimals = 2) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: decimals })
}

function buildWalletSummary(address, summary, title, validatorList = []) {
  const lines = []
  lines.push(`${title}\n`)
  lines.push(`<code>${escapeHtml(address)}</code>\n`)

  // KLV
  lines.push(`<b>KLV frozen:</b> ${escapeHtml(fmt(summary.frozenKlv))} KLV`)
  if (summary.lastClaimKlv > 0) {
    lines.push(`<b>Último StakingClaim:</b> época ${summary.lastClaimKlv}`)
  }

  // Delegaciones agrupadas
  if (summary.delegations.length > 0) {
    lines.push(`\n<b>Delegaciones activas:</b>`)
    for (let i = 0; i < summary.delegations.length; i++) {
      const d    = summary.delegations[i]
      const name = escapeHtml(d.validatorName || `${d.validatorAddr.slice(0, 10)}...`)

      // Estado del validador desde el snapshot
      let statusTag = ''
      if (validatorList.length > 0) {
        const v = validatorList.find(v => v.address === d.validatorAddr)
        if (v) {
          if (v.jailed)         statusTag = ' <i>(en jail)</i>'
          else if (v.waiting)   statusTag = ' <i>(en espera)</i>'
          else if (v.inactive)  statusTag = ' <i>(inactivo)</i>'
        }
      }

      lines.push(`  ${i + 1}. <b>${name}</b> — ${escapeHtml(fmt(d.balance))} KLV${statusTag}`)
    }
  } else {
    lines.push(`\n<i>Sin delegaciones activas</i>`)
  }

  // KFI
  if (summary.frozenKfi > 0) {
    lines.push(`\n<b>KFI frozen:</b> ${escapeHtml(fmt(summary.frozenKfi))} KFI`)
    if (summary.lastClaimKfi > 0) {
      lines.push(`<b>Último claim KFI:</b> época ${summary.lastClaimKfi}`)
    }
  }

  lines.push(`\n<i>Alertas activas: recompensas próximas a caducar y cambios de comisión</i>`)
  return lines.join('\n')
}

// ─── Crear bot ────────────────────────────────────────────────────────────────

function createBot(pool) {
  const bot = new Telegraf(BOT_TOKEN)

  // /start (con o sin código de vinculación de Desna Wallet)
  bot.command('start', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1)
    const code = args[0]?.trim()

    // ── Vinculación desde la app Desna ──────────────────────────
    if (code && code.length > 10) {
      try {
        const result = await pool.query(
          `SELECT wallet_address, link_code_expires_at
           FROM telegram_connections
           WHERE link_code = $1`,
          [code]
        )

        if (!result.rows.length) {
          return ctx.reply(
            '❌ *Código inválido*\n\nEste código no existe o ya fue usado\\.\nGenera uno nuevo desde la app Desna\\.',
            { parse_mode: 'MarkdownV2' }
          )
        }

        const { wallet_address, link_code_expires_at } = result.rows[0]

        if (new Date() > new Date(link_code_expires_at)) {
          return ctx.reply(
            '⏱ *Código expirado*\n\nEl código solo es válido 10 minutos\\.\nGenera uno nuevo desde la app Desna\\.',
            { parse_mode: 'MarkdownV2' }
          )
        }

        const chatId = ctx.from.id

        // Si este chat_id ya está vinculado a otra wallet, desactivar la anterior
        await pool.query(
          `UPDATE telegram_connections
           SET is_active = FALSE, updated_at = NOW()
           WHERE telegram_chat_id = $1 AND wallet_address != $2`,
          [chatId, wallet_address]
        )

        // Vincular
        await pool.query(
          `UPDATE telegram_connections
           SET telegram_chat_id      = $1,
               telegram_username     = $2,
               is_active             = TRUE,
               link_code             = NULL,
               link_code_expires_at  = NULL,
               linked_at             = NOW(),
               updated_at            = NOW()
           WHERE wallet_address = $3`,
          [chatId, ctx.from.username ?? null, wallet_address]
        )

        // Crear preferencias por defecto si no existen
        await pool.query(
          `INSERT INTO notification_preferences (wallet_address)
           VALUES ($1) ON CONFLICT DO NOTHING`,
          [wallet_address]
        )

        const shortWallet = `${wallet_address.slice(0, 8)}...${wallet_address.slice(-6)}`

        return ctx.reply(
          `✅ *Wallet vinculada*\n\n` +
          `\`${escapeMarkdown(shortWallet)}\` ya está conectada a este chat\\.\n\n` +
          `Desde la app Desna puedes configurar qué alertas quieres recibir aquí:\n\n` +
          `• 💸 Transacciones recibidas\n` +
          `• 📊 Alertas de precio\n` +
          `• ⏳ Vencimiento de delegaciones\n` +
          `• 🚨 Cambios en validadores\n` +
          `• 🎁 Resumen de rewards`,
          { parse_mode: 'MarkdownV2' }
        )
      } catch (err) {
        console.error('[bot /start link]', err.message)
        return ctx.reply('❌ Error interno\\. Inténtalo de nuevo en unos minutos\\.', { parse_mode: 'MarkdownV2' })
      }
    }

    // ── Bienvenida normal ────────────────────────────────────────
    const name = escapeMarkdown(ctx.from?.first_name ?? 'Anon')
    await ctx.reply(
      `👋 Hola ${name}\\!\n\n` +
      `Soy *Lyra*, el analista de red de Desna\\.\n\n` +
      `Monitorizo la red Klever en tiempo real y publico un informe completo al cierre de cada época \\(cada 6 horas\\) en el canal privado de suscriptores, con estadísticas de red, actividad on\\-chain, estado de validadores y mucho más\\.\n\n` +
      `*Comandos disponibles:*\n` +
      `/suscribir — obtén acceso al canal premium \\(\\$2 en KLV, pago único\\)\n` +
      `/wallet — ver tus wallets registradas\n` +
      `/wallet \\[klv1\\.\\.\\.\\] — añadir una wallet para alertas personalizadas\n` +
      `/wallet eliminar \\[klv1\\.\\.\\.\\] — eliminar una wallet\n` +
      `/estado — ver tu suscripción y delegaciones activas\n`,
      { parse_mode: 'MarkdownV2' }
    )
  })

  // /desvincular — desvincula la wallet de Desna desde Telegram
  bot.command('desvincular', async (ctx) => {
    const chatId = ctx.from.id
    try {
      const result = await pool.query(
        `UPDATE telegram_connections
         SET is_active = FALSE, updated_at = NOW()
         WHERE telegram_chat_id = $1 AND is_active = TRUE
         RETURNING wallet_address`,
        [chatId]
      )
      if (!result.rows.length) {
        return ctx.reply('No tienes ninguna wallet vinculada\\.', { parse_mode: 'MarkdownV2' })
      }
      ctx.reply('✅ Wallet desvinculada correctamente\\.\n\nYa no recibirás alertas aquí\\.', { parse_mode: 'MarkdownV2' })
    } catch (err) {
      console.error('[bot /desvincular]', err.message)
      ctx.reply('❌ Error interno\\. Inténtalo de nuevo\\.', { parse_mode: 'MarkdownV2' })
    }
  })

  // /suscribir
  bot.command('suscribir', async (ctx) => {
    const telegramId = ctx.from.id

    const existing = await pool.query(
      'SELECT active, payment_code FROM bot_subscribers WHERE telegram_id = $1',
      [telegramId]
    )

    if (existing.rows[0]?.active) {
      return ctx.reply('✅ Ya tienes suscripción activa\\. Usa /estado para ver los detalles\\.', {
        parse_mode: 'MarkdownV2',
      })
    }

    // Comprobar si tiene un registro pendiente caducado (>24h)
    if (existing.rows.length > 0 && !existing.rows[0].active) {
      const createdAt = new Date(existing.rows[0].created_at)
      const hoursOld  = (Date.now() - createdAt.getTime()) / 3_600_000
      if (hoursOld > 24) {
        // Borrar el registro caducado y generar uno nuevo
        await pool.query('DELETE FROM bot_subscribers WHERE telegram_id = $1', [telegramId])
        existing.rows = []
      }
    }

    const klvPrice  = await fetchKlvPrice()
    const klvAmount = (SUBSCRIPTION_USD / klvPrice).toFixed(2)

    let code = existing.rows[0]?.payment_code
    if (!code) {
      code = generatePaymentCode()
      await pool.query(
        `INSERT INTO bot_subscribers (telegram_id, telegram_username, payment_code)
         VALUES ($1, $2, $3)
         ON CONFLICT (telegram_id) DO UPDATE SET payment_code = $3`,
        [telegramId, ctx.from.username ?? null, code]
      )
    }

    await ctx.reply(
      `🔐 *Instrucciones de pago*\n\n` +
      `Envía exactamente *${escapeMarkdown(klvAmount)} KLV* \\(≈ \\$${SUBSCRIPTION_USD} USD\\) a:\n\n` +
      `\`${escapeMarkdown(KLV_RECEIVE_ADDRESS)}\`\n\n` +
      `⚠️ *IMPORTANTE:* Incluye este código en el campo *memo* de la transacción:\n\n` +
      `\`${escapeMarkdown(code)}\`\n\n` +
      `Sin el memo correcto el pago no podrá verificarse\\.\n\n` +
      `⏳ Este código y precio son válidos durante *24 horas*\\. Pasado ese tiempo deberás iniciar el proceso de nuevo\\.\n\n` +
      `Una vez enviado, usa:\n` +
      `/pagar \\[hash de la transacción\\]`,
      { parse_mode: 'MarkdownV2' }
    )
  })

  // /pagar [txhash]
  bot.command('pagar', async (ctx) => {
    const telegramId = ctx.from.id
    const args       = ctx.message.text.split(' ').slice(1)
    const txHash     = args[0]?.trim()

    if (!txHash) {
      return ctx.reply('Uso: /pagar \\[hash de la transacción\\]', { parse_mode: 'MarkdownV2' })
    }

    const subRes = await pool.query(
      'SELECT * FROM bot_subscribers WHERE telegram_id = $1',
      [telegramId]
    )

    if (subRes.rows.length === 0) {
      return ctx.reply('Primero usa /suscribir para iniciar el proceso\\.', { parse_mode: 'MarkdownV2' })
    }

    const sub = subRes.rows[0]

    if (sub.active) {
      return ctx.reply('✅ Ya tienes suscripción activa\\.', { parse_mode: 'MarkdownV2' })
    }

    const hashUsed = await pool.query(
      'SELECT id FROM bot_subscribers WHERE payment_tx_hash = $1',
      [txHash]
    )
    if (hashUsed.rows.length > 0) {
      return ctx.reply('❌ Este hash ya fue utilizado por otro usuario\\.', { parse_mode: 'MarkdownV2' })
    }

    await ctx.reply('🔍 Verificando transacción\\.\\.\\. un momento\\.', { parse_mode: 'MarkdownV2' })

    try {
      const verification = await verifyPayment(txHash, sub.payment_code, KLV_RECEIVE_ADDRESS)

      if (!verification.valid) {
        return ctx.reply(
          `❌ *Verificación fallida:*\n${verification.reason}`,
          { parse_mode: 'MarkdownV2' }
        )
      }

      const klvPrice = await fetchKlvPrice()

      await pool.query(
        `UPDATE bot_subscribers SET
          active               = TRUE,
          payment_tx_hash      = $1,
          klv_paid             = $2,
          usd_value_paid       = $3,
          klv_price_at_payment = $4,
          paid_at              = NOW()
         WHERE telegram_id = $5`,
        [
          txHash,
          verification.klvAmount,
          (verification.klvAmount * klvPrice).toFixed(4),
          klvPrice,
          telegramId,
        ]
      )

      await ctx.reply(
        `✅ *¡Pago verificado\\!*\n\n` +
        `Has pagado *${escapeMarkdown(verification.klvAmount.toFixed(2))} KLV*\\.\n\n` +
        `Serás añadido al canal privado en breve\\.\n` +
        `Si no recibes la invitación en 24h, contacta con el administrador\\.`,
        { parse_mode: 'MarkdownV2' }
      )

      await bot.telegram.sendMessage(
        ADMIN_TELEGRAM_ID,
        `🆕 *Nuevo suscriptor\\!*\n` +
        `ID: \`${telegramId}\`\n` +
        `Usuario: @${escapeMarkdown(ctx.from.username ?? 'sin username')}\n` +
        `KLV pagados: ${escapeMarkdown(verification.klvAmount.toFixed(2))}\n` +
        `TX: \`${escapeMarkdown(txHash)}\`\n\n` +
        `⚠️ Añádelo manualmente al canal privado\\.`,
        { parse_mode: 'MarkdownV2' }
      )

    } catch (err) {
      console.error('[bot] Error verificando pago:', err.message)
      await ctx.reply(
        '❌ Error al verificar la transacción\\. Inténtalo de nuevo o contacta al administrador\\.',
        { parse_mode: 'MarkdownV2' }
      )
    }
  })

  // /estado
  bot.command('estado', async (ctx) => {
    const telegramId = ctx.from.id
    const res = await pool.query(
      'SELECT * FROM bot_subscribers WHERE telegram_id = $1',
      [telegramId]
    )

    if (res.rows.length === 0 || !res.rows[0].active) {
      return ctx.reply(
        '❌ No tienes suscripción activa\\.\n\nUsa /suscribir para obtener acceso\\.',
        { parse_mode: 'MarkdownV2' }
      )
    }

    const sub     = res.rows[0]
    const paidAt  = new Date(sub.paid_at).toUTCString().replace(' GMT', ' UTC')
    const klvPaid = parseFloat(sub.klv_paid).toFixed(2)
    const usdPaid = parseFloat(sub.usd_value_paid).toFixed(2)

    await ctx.replyWithHTML(
      `✅ <b>Suscripción activa</b>\n\n` +
      `Pagado: <b>${escapeHtml(klvPaid)} KLV</b> ($${escapeHtml(usdPaid)})\n` +
      `Fecha: ${escapeHtml(paidAt)}`
    )

    // Mostrar resumen de cada wallet
    const wallets = await pool.query(
      'SELECT klever_address FROM bot_wallets WHERE telegram_id = $1 ORDER BY created_at ASC',
      [telegramId]
    )

    if (wallets.rows.length === 0) {
      return ctx.replyWithHTML(
        `📭 <b>Sin wallets registradas</b>\n\n` +
        `Usa <code>/wallet klv1...</code> para añadir tu dirección KLV y recibir alertas personalizadas.`
      )
    }

    // Obtener lista de validadores del último snapshot (una sola vez)
    const snapRes = await pool.query(
      'SELECT validator_list FROM bot_epoch_snapshots ORDER BY epoch_number DESC LIMIT 1'
    )
    const validatorList = snapRes.rows[0]?.validator_list ?? []

    for (let i = 0; i < wallets.rows.length; i++) {
      const addr = wallets.rows[i].klever_address
      try {
        const summary = await getDelegationsSummary(addr)
        if (!summary) {
          await ctx.replyWithHTML(`👛 <b>Wallet ${i + 1}</b>\n<code>${escapeHtml(addr)}</code>\n\n<i>No se pudo obtener información.</i>`)
          continue
        }
        await ctx.replyWithHTML(buildWalletSummary(addr, summary, `👛 <b>Wallet ${i + 1}</b>`, validatorList))
      } catch (err) {
        console.error(`[bot] Error obteniendo wallet ${addr}:`, err.message)
      }
    }
  })

  // /wallet — gestión de wallets (máx 3)
  bot.command('wallet', async (ctx) => {
    const telegramId = ctx.from.id
    const args       = ctx.message.text.split(' ').slice(1)
    const action     = args[0]?.trim().toLowerCase()
    const address    = args[1]?.trim() ?? args[0]?.trim()

    // Verificar suscripción
    const sub = await pool.query(
      'SELECT active FROM bot_subscribers WHERE telegram_id = $1',
      [telegramId]
    )
    if (!sub.rows[0]?.active) {
      return ctx.reply('❌ Necesitas suscripción activa\\. Usa /suscribir\\.', { parse_mode: 'MarkdownV2' })
    }

    // /wallet sin argumentos — listar wallets
    if (!action) {
      const wallets = await pool.query(
        'SELECT klever_address, created_at FROM bot_wallets WHERE telegram_id = $1 ORDER BY created_at ASC',
        [telegramId]
      )
      if (wallets.rows.length === 0) {
        return ctx.replyWithHTML(
          `📭 <b>Sin wallets registradas</b>\n\n` +
          `Usa <code>/wallet klv1...</code> para añadir tu dirección KLV.\n` +
          `Puedes registrar hasta 3 wallets.`
        )
      }
      const list = wallets.rows
        .map((r, i) => `  ${i + 1}. <code>${escapeHtml(r.klever_address)}</code>`)
        .join('\n')
      return ctx.replyWithHTML(
        `👛 <b>Tus wallets registradas</b>\n\n${list}\n\n` +
        `Usa <code>/wallet eliminar klv1...</code> para eliminar una.`
      )
    }

    // /wallet eliminar [klv1...]
    if (action === 'eliminar') {
      if (!address || !address.startsWith('klv1')) {
        return ctx.reply('Uso: /wallet eliminar \\[klv1\\.\\.\\.\\.\\]', { parse_mode: 'MarkdownV2' })
      }
      const del = await pool.query(
        'DELETE FROM bot_wallets WHERE telegram_id = $1 AND klever_address = $2 RETURNING id',
        [telegramId, address]
      )
      if (del.rowCount === 0) {
        return ctx.replyWithHTML(`❌ Esa dirección no está en tu lista.`)
      }
      return ctx.replyWithHTML(`✅ Wallet eliminada:\n<code>${escapeHtml(address)}</code>`)
    }

    // /wallet [klv1...] — añadir wallet
    const newAddress = action.startsWith('klv1') ? action : null
    if (!newAddress) {
      return ctx.reply('Uso: /wallet \\[klv1\\.\\.\\.\\.\\]', { parse_mode: 'MarkdownV2' })
    }

    // Comprobar límite de 3
    const count = await pool.query(
      'SELECT COUNT(*) FROM bot_wallets WHERE telegram_id = $1',
      [telegramId]
    )
    if (parseInt(count.rows[0].count) >= 3) {
      return ctx.replyWithHTML(
        `❌ <b>Límite alcanzado</b>\n\nYa tienes 3 wallets registradas.\n` +
        `Elimina una con <code>/wallet eliminar klv1...</code> antes de añadir otra.`
      )
    }

    // Verificar que no está duplicada
    const existing = await pool.query(
      'SELECT id FROM bot_wallets WHERE telegram_id = $1 AND klever_address = $2',
      [telegramId, newAddress]
    )
    if (existing.rows.length > 0) {
      return ctx.replyWithHTML(`ℹ️ Esa wallet ya está registrada.`)
    }

    await ctx.replyWithHTML('🔍 Verificando dirección...')

    try {
      const summary = await getDelegationsSummary(newAddress)
      if (!summary) {
        return ctx.replyWithHTML('❌ Dirección no encontrada en la red Klever.')
      }

      // Guardar wallet
      await pool.query(
        `INSERT INTO bot_wallets (telegram_id, klever_address)
         VALUES ($1, $2)
         ON CONFLICT (telegram_id, klever_address) DO NOTHING`,
        [telegramId, newAddress]
      )

      // Obtener lista de validadores del último snapshot
      const snapRes = await pool.query(
        'SELECT validator_list FROM bot_epoch_snapshots ORDER BY epoch_number DESC LIMIT 1'
      )
      const validatorList = snapRes.rows[0]?.validator_list ?? []

      await ctx.replyWithHTML(buildWalletSummary(newAddress, summary, '✅ <b>Wallet registrada</b>', validatorList))
    } catch (err) {
      console.error('[bot] Error en /wallet:', err.message)
      await ctx.replyWithHTML('❌ Error al verificar la dirección. Inténtalo más tarde.')
    }
  })

  // /enviar CANTIDAD DIRECCION TOKEN
  bot.command('enviar', async (ctx) => {
    const telegramId = ctx.from.id
    const args       = ctx.message.text.split(' ').slice(1)

    if (args.length < 3) {
      return ctx.replyWithHTML(
        `⚠️ <b>Formato incorrecto</b>\n\n` +
        `Uso: <code>/enviar CANTIDAD DIRECCION TOKEN</code>\n` +
        `Ejemplo: <code>/enviar 10 klv1abcde...xyz KLV</code>`
      )
    }

    const [amountStr, destinationRaw, tokenSymbolRaw] = args
    const destination = destinationRaw.trim().toLowerCase()
    const tokenSymbol = tokenSymbolRaw.trim().toUpperCase()

    // Validar cantidad
    const amount = parseFloat(amountStr.replace(',', '.'))
    if (!Number.isFinite(amount) || amount <= 0) {
      return ctx.replyWithHTML('❌ Cantidad inválida. Debe ser un número mayor que 0.')
    }

    // Validar dirección destino (solo klv1..., sin resolución .klv)
    if (!/^klv1[a-z0-9]{58}$/.test(destination)) {
      return ctx.replyWithHTML('❌ Dirección destino inválida. Debe empezar por <code>klv1</code>.')
    }

    // Resolver token contra la tabla tokens (chain_id = 'klever')
    const tokenRes = await pool.query(
      `SELECT id, precision FROM tokens WHERE chain_id = 'klever' AND UPPER(symbol) = $1 LIMIT 1`,
      [tokenSymbol]
    )
    if (tokenRes.rows.length === 0) {
      return ctx.replyWithHTML(`❌ Token <b>${escapeHtml(tokenSymbol)}</b> no reconocido.`)
    }
    const { id: tokenId, precision } = tokenRes.rows[0]

    try {
      // Wallet custodial: crearla automáticamente si es la primera vez
      let address = await custodialService.getCustodialAddress(telegramId)
      if (!address) {
        const created = await custodialService.createWallet(telegramId)
        if (!created.success) {
          console.error('[enviar] Error creando wallet custodial:', created.error)
          return ctx.replyWithHTML('❌ No se pudo crear tu wallet. Inténtalo más tarde.')
        }
        address = created.address
        return ctx.replyWithHTML(
          `🆕 <b>Wallet creada</b>\n\n` +
          `<code>${escapeHtml(address)}</code>\n\n` +
          `Aún no tiene fondos. Deposita ${escapeHtml(tokenSymbol)} en esa dirección y vuelve a ejecutar el comando <code>/enviar</code>.`
        )
      }

      // Evitar enviar a la propia wallet por error
      if (destination === address.toLowerCase()) {
        return ctx.replyWithHTML('⚠️ La dirección destino coincide con tu propia wallet. Operación cancelada.')
      }

      await ctx.replyWithHTML('⏳ Enviando...')

      const result = await custodialService.sendTransfer(telegramId, destination, amount, tokenId, precision)

      if (result.success) {
        await ctx.replyWithHTML(
          `✅ <b>Envío realizado</b>\n\n` +
          `<b>Cantidad:</b> ${escapeHtml(amount)} ${escapeHtml(tokenSymbol)}\n` +
          `<b>Destino:</b> <code>${escapeHtml(destination)}</code>\n` +
          `<b>Hash:</b> <code>${escapeHtml(result.txHash)}</code>`
        )
      } else {
        console.error('[enviar] Error en sendTransfer:', result.error)
        await ctx.replyWithHTML(`❌ Error al enviar: ${escapeHtml(String(result.error))}`)
      }
    } catch (err) {
      console.error('[enviar] Error inesperado:', err.message)
      await ctx.replyWithHTML('❌ Error interno. Inténtalo de nuevo más tarde.')
    }
  })

  // /admin — solo admin
  bot.command('admin', async (ctx) => {
    if (ctx.from.id !== ADMIN_TELEGRAM_ID) return

    try {
      // Stats de suscriptores
      const subStats = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE active = TRUE)  as activos,
          COUNT(*) FILTER (WHERE active = FALSE) as pendientes,
          COUNT(*)                                as total
        FROM bot_subscribers
      `)

      // Ingresos
      const ingresos = await pool.query(`
        SELECT
          COALESCE(SUM(klv_paid), 0)         as total_klv,
          COALESCE(AVG(klv_paid), 0)         as avg_klv,
          COALESCE(AVG(klv_price_at_payment), 0) as avg_price
        FROM bot_subscribers
        WHERE active = TRUE
      `)

      // Wallets registradas
      const wallets = await pool.query(`
        SELECT COUNT(*) as total FROM bot_wallets
      `)

      const walletsConWallet = await pool.query(`
        SELECT COUNT(DISTINCT telegram_id) as total FROM bot_wallets
      `)

      // Último snapshot
      const snap = await pool.query(`
        SELECT epoch_number, created_at, tx_count, dau, klv_price_usdt
        FROM bot_epoch_snapshots
        ORDER BY epoch_number DESC LIMIT 1
      `)

      const s  = subStats.rows[0]
      const ig = ingresos.rows[0]
      const w  = wallets.rows[0]
      const wc = walletsConWallet.rows[0]
      const sn = snap.rows[0]

      // Calcular próximo informe
      const now        = new Date()
      const hours      = now.getUTCHours()
      const cronHours  = [3, 9, 15, 21]
      const nextHour   = cronHours.find(h => h > hours) ?? (cronHours[0] + 24)
      const hoursLeft  = nextHour > hours ? nextHour - hours : (nextHour + 24) - hours
      const minsLeft   = 60 - now.getUTCMinutes()
      const nextTime   = `~${hoursLeft}h ${minsLeft}m`

      const lastEpoch  = sn ? `época ${sn.epoch_number} (${new Date(sn.created_at).toUTCString().replace(' GMT', ' UTC')})` : 'Sin datos'

      await ctx.replyWithHTML(
        `📊 <b>PANEL ADMIN — Desna Bot</b>\n\n` +
        `👥 <b>Suscriptores</b>\n` +
        `  Activos:    <b>${s.activos}</b>\n` +
        `  Pendientes: ${s.pendientes}\n` +
        `  Total:      ${s.total}\n` +
        `  Con wallet: ${wc.total} / ${s.activos}\n` +
        `  Wallets registradas: ${w.total}\n\n` +
        `💰 <b>Ingresos</b>\n` +
        `  Total KLV recibidos: <b>${parseFloat(ig.total_klv).toFixed(2)} KLV</b>\n` +
        `  Media por pago:      ${parseFloat(ig.avg_klv).toFixed(2)} KLV\n` +
        `  Precio medio KLV:    $${parseFloat(ig.avg_price).toFixed(6)}\n\n` +
        `🤖 <b>Bot</b>\n` +
        `  Último informe: ${escapeHtml(lastEpoch)}\n` +
        `  Próximo informe: ${nextTime}\n` +
        (sn ? `  Txs última época: ${sn.tx_count} | DAU: ${sn.dau}\n` : '') +
        (sn ? `  KLV precio:       $${parseFloat(sn.klv_price_usdt).toFixed(6)}\n` : '')
      )
    } catch (err) {
      console.error('[admin] Error:', err.message)
      await ctx.replyWithHTML(`❌ Error: ${escapeHtml(err.message)}`)
    }
  })

  // /test — solo admin
  bot.command('test', async (ctx) => {
    if (ctx.from.id !== ADMIN_TELEGRAM_ID) return

    await ctx.reply('⏳ Generando informe de prueba\\.\\.\\.', { parse_mode: 'MarkdownV2' })

    try {
      const snapshot = await collectEpochSnapshot()
      const previous = await getPreviousSnapshot(pool, snapshot.epochNumber)

      await saveEpochSnapshot(pool, snapshot)

      const messages = buildEpochMessages(snapshot, previous)

      for (const msg of messages) {
        await bot.telegram.sendMessage(PRIVATE_CHANNEL_ID, msg, { parse_mode: 'HTML' })
      }

      await ctx.reply('✅ Informe publicado en el canal\\.', { parse_mode: 'MarkdownV2' })
    } catch (err) {
      console.error('[test] Error:', err.message)
      await ctx.reply(`❌ Error: ${escapeMarkdown(err.message)}`, { parse_mode: 'MarkdownV2' })
    }
  })

  // /testalerts — solo admin
  bot.command('testalerts', async (ctx) => {
    if (ctx.from.id !== ADMIN_TELEGRAM_ID) return

    await ctx.reply('⏳ Ejecutando alertas personalizadas de prueba\\.\\.\\.', { parse_mode: 'MarkdownV2' })

    try {
      const snapRes   = await pool.query(
        'SELECT * FROM bot_epoch_snapshots ORDER BY epoch_number DESC LIMIT 2'
      )
      const current  = snapRes.rows[0] ?? null
      const previous = snapRes.rows[1] ?? null

      const currentSnapshot  = current  ? { validatorList: current.validator_list  ?? [], validatorsElected: current.validators_elected,  validatorsJailed: current.validators_jailed  } : null
      const previousSnapshot = previous ? { validatorList: previous.validator_list ?? [], validatorsElected: previous.validators_elected, validatorsJailed: previous.validators_jailed } : null

      const status       = await require('./epochService').getNodeStatus()
      const currentEpoch = status.epochNumber

      await runPersonalAlerts(pool, bot, currentEpoch, currentSnapshot, previousSnapshot)

      await ctx.reply('✅ Alertas personalizadas ejecutadas\\.', { parse_mode: 'MarkdownV2' })
    } catch (err) {
      console.error('[testalerts] Error:', err.message)
      await ctx.reply(`❌ Error: ${escapeMarkdown(err.message)}`, { parse_mode: 'MarkdownV2' })
    }
  })

  return bot
}

// ─── Cron de época ────────────────────────────────────────────────────────────

function startEpochCron(pool, bot) {
  // Épocas Klever: genesis 2022-07-01 09:00 UTC → caen a las 03,09,15,21 UTC
  cron.schedule('0 3,9,15,21 * * *', async () => {
    console.log('[cron] Disparando recopilación de época...')
    try {
      const snapshot = await collectEpochSnapshot()
      const previous = await getPreviousSnapshot(pool, snapshot.epochNumber)

      await saveEpochSnapshot(pool, snapshot)

      const messages = buildEpochMessages(snapshot, previous)

      for (const msg of messages) {
        await bot.telegram.sendMessage(PRIVATE_CHANNEL_ID, msg, { parse_mode: 'HTML' })
      }

      await sendValidatorAlerts(pool, bot, snapshot, previous)
      await runPersonalAlerts(pool, bot, snapshot.epochNumber, snapshot, previous)

      console.log(`[cron] Época ${snapshot.epochNumber} publicada correctamente`)
    } catch (err) {
      console.error('[cron] Error en recopilación de época:', err.message)
    }
  }, { timezone: 'UTC' })

  console.log('[cron] Cron de época registrado — 0 3,9,15,21 * * * UTC')

  // Limpieza diaria de suscripciones pendientes caducadas (>24h sin pagar)
  cron.schedule('0 0 * * *', async () => {
    console.log('[cron] Limpiando suscripciones pendientes caducadas...')
    try {
      const res = await pool.query(
        `DELETE FROM bot_subscribers
         WHERE active = FALSE
         AND created_at < NOW() - INTERVAL '24 hours'
         RETURNING telegram_id`
      )
      console.log(`[cron] ${res.rowCount} suscripciones pendientes eliminadas`)
    } catch (err) {
      console.error('[cron] Error en limpieza:', err.message)
    }
  }, { timezone: 'UTC' })

  console.log('[cron] Cron de limpieza registrado — 0 0 * * * UTC')
}

module.exports = { createBot, startEpochCron }
