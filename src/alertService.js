/**
 * alertService.js
 * Alertas personalizadas por usuario al cierre de cada época
 * - Recompensas KLV Staking próximas a caducar
 * - Recompensas KLV Allowance (delegación) próximas a caducar
 * - Cambio de comisión en validadores delegados
 * - Resumen personal: validadores con incidencias y cambios de comisión
 */

const KLEVER_API        = 'https://api.mainnet.klever.org'
const MAX_CLAIM_EPOCHS  = parseInt(process.env.MAX_CLAIM_EPOCHS  ?? '100')
const CLAIM_WARN_EPOCHS = parseInt(process.env.CLAIM_WARN_EPOCHS ?? '10')

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function shortAddr(addr) {
  if (!addr || addr.length < 12) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function epochsToHours(epochs) {
  return epochs * 6
}

function fmtKlv(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M KLV`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K KLV`
  return `${n.toFixed(2)} KLV`
}

// ─── Leer datos de cuenta ─────────────────────────────────────────────────────

async function fetchAccountData(kleverAddress) {
  const res  = await fetch(`${KLEVER_API}/v1.0/address/${kleverAddress}`)
  const json = await res.json()
  if (json.error || !json.data?.account) return null
  return json.data.account
}

// ─── Última tx de AllowanceClaim ──────────────────────────────────────────────

async function fetchLastAllowanceClaimEpoch(kleverAddress) {
  try {
    const res  = await fetch(
      `${KLEVER_API}/v1.0/address/${kleverAddress}/transactions?type=9&limit=20&page=1`
    )
    const json = await res.json()
    const txs  = json?.data?.transactions ?? []

    for (const tx of txs) {
      const contracts = Array.isArray(tx.contract) ? tx.contract : []
      for (const c of contracts) {
        if (c.parameter?.claimType === 'AllowanceClaim') {
          // Calcular época aproximada desde el timestamp
          // genesis: 1656680400, slot duration: 4s, slots per epoch: 5400
          const epochDuration = 5400 * 4 // 21600s
          const epoch = Math.floor((tx.timestamp - 1656680400) / epochDuration)
          return epoch
        }
      }
    }
  } catch (err) {
    console.error(`[alertService] Error fetching allowance claim ${kleverAddress}:`, err.message)
  }
  return null
}

// ─── Buckets KLV activos con delegación ──────────────────────────────────────

function getActiveDelegations(account) {
  const klvAsset = account.assets?.KLV
  if (!klvAsset?.buckets?.length) return []

  return klvAsset.buckets
    .filter(b => b.unstakedEpoch === 4294967295 && b.delegation)
    .map(b => ({
      bucketId:      b.id,
      validatorAddr: b.delegation,
      validatorName: b.validatorName ?? '',
      balance:       b.balance / 1_000_000,
    }))
}

// ─── Alerta de recompensas KLV Staking ───────────────────────────────────────

async function checkKlvStakingAlert(bot, telegramId, kleverAddress, currentEpoch, account) {
  const lastClaimEpoch = account.assets?.KLV?.lastClaim?.epoch ?? 0
  if (lastClaimEpoch === 0) return

  const epochsSince     = currentEpoch - lastClaimEpoch
  const epochsRemaining = MAX_CLAIM_EPOCHS - epochsSince
  if (epochsRemaining > CLAIM_WARN_EPOCHS || epochsRemaining <= 0) return

  // Obtener importe pendiente
  let pendingKlv = 0
  try {
    const res  = await fetch(`${KLEVER_API}/v1.0/address/${kleverAddress}/allowance`)
    const json = await res.json()
    pendingKlv = (json?.data?.result?.stakingRewards ?? 0) / 1_000_000
  } catch {}

  await bot.telegram.sendMessage(
    telegramId,
    `⚠️ <b>Recompensas de Staking KLV próximas a caducar</b>\n\n` +
    `Wallet: <code>${escapeHtml(kleverAddress)}</code>\n\n` +
    `Pendiente: <b>${fmtKlv(pendingKlv)}</b>\n` +
    `Te quedan <b>${epochsRemaining} épocas</b> (~${epochsToHours(epochsRemaining)}h) para reclamar.\n\n` +
    `Último StakingClaim: época <b>${lastClaimEpoch}</b>\n` +
    `Caduca en: época <b>${lastClaimEpoch + MAX_CLAIM_EPOCHS}</b>\n\n` +
    `Reclama cuanto antes desde Desna Wallet para no perder tus recompensas.\n\n` +
    `<i>Desna · La wallet que te entiende</i>`,
    { parse_mode: 'HTML' }
  )
}

// ─── Alerta de recompensas KLV Allowance (delegación + KFI) ─────────────────

async function checkKlvAllowanceAlert(bot, telegramId, kleverAddress, currentEpoch) {
  const lastAllowanceEpoch = await fetchLastAllowanceClaimEpoch(kleverAddress)
  if (lastAllowanceEpoch === null) return

  const epochsSince     = currentEpoch - lastAllowanceEpoch
  const epochsRemaining = MAX_CLAIM_EPOCHS - epochsSince
  if (epochsRemaining > CLAIM_WARN_EPOCHS || epochsRemaining <= 0) return

  // Obtener importes pendientes
  let pendingKlv = 0
  let hasKfi     = false
  try {
    const res  = await fetch(`${KLEVER_API}/v1.0/address/${kleverAddress}/allowance`)
    const json = await res.json()
    pendingKlv = (json?.data?.result?.allowance ?? 0) / 1_000_000
    // Si tiene KFI frozen, las recompensas KFI también van aquí
    hasKfi = !!json?.data?.result?.allStakingRewards?.find(r => r.assetId === 'KFI')
  } catch {}

  const kfiNote = hasKfi ? ' (incluye recompensas de KFI)' : ''

  await bot.telegram.sendMessage(
    telegramId,
    `⚠️ <b>Recompensas de Delegación y KFI próximas a caducar</b>\n\n` +
    `Wallet: <code>${escapeHtml(kleverAddress)}</code>\n\n` +
    `Pendiente: <b>${fmtKlv(pendingKlv)}</b>${escapeHtml(kfiNote)}\n` +
    `Te quedan <b>${epochsRemaining} épocas</b> (~${epochsToHours(epochsRemaining)}h) para reclamar.\n\n` +
    `Último AllowanceClaim: época <b>${lastAllowanceEpoch}</b>\n` +
    `Caduca en: época <b>${lastAllowanceEpoch + MAX_CLAIM_EPOCHS}</b>\n\n` +
    `Reclama cuanto antes desde Desna Wallet para no perder tus recompensas.\n\n` +
    `<i>Desna · La wallet que te entiende</i>`,
    { parse_mode: 'HTML' }
  )
}
// ─── Alerta de cambio de comisión ────────────────────────────────────────────

async function checkCommissionAlerts(bot, telegramId, kleverAddress, previousSnapshot, account) {
  if (!previousSnapshot?.validatorList?.length) return

  const delegations = getActiveDelegations(account)
  if (!delegations.length) return

  for (const delegation of delegations) {
    const prevValidator = previousSnapshot.validatorList.find(
      v => v.address === delegation.validatorAddr
    )
    if (!prevValidator) continue

    try {
      const res  = await fetch(`${KLEVER_API}/v1.0/validator/${delegation.validatorAddr}`)
      const json = await res.json()
      const currCommission = json?.data?.validator?.commission ?? null
      if (currCommission === null) continue

      const prevCommission = prevValidator.commission
      if (currCommission === prevCommission) continue

      const prevPct = (prevCommission / 100).toFixed(2)
      const currPct = (currCommission / 100).toFixed(2)
      const change  = currCommission > prevCommission ? '📈 subió' : '📉 bajó'
      const name    = escapeHtml(delegation.validatorName || shortAddr(delegation.validatorAddr))

      await bot.telegram.sendMessage(
        telegramId,
        `🔔 <b>Cambio de comisión en tu validador</b>\n\n` +
        `Wallet: <code>${escapeHtml(kleverAddress)}</code>\n\n` +
        `El validador <b>${name}</b> al que tienes <b>${delegation.balance.toFixed(2)} KLV</b> delegados\n` +
        `${change} su comisión:\n\n` +
        `  Antes: <b>${prevPct}%</b>\n` +
        `  Ahora: <b>${currPct}%</b>\n\n` +
        `Puedes redelegar desde Desna Wallet si lo consideras oportuno.`,
        { parse_mode: 'HTML' }
      )
    } catch (err) {
      console.error(`[alertService] Error commission check ${delegation.validatorAddr}:`, err.message)
    }
  }
}

// ─── Resumen personal: incidencias y cambios de comisión ─────────────────────

async function buildPersonalSummary(bot, telegramId, kleverAddress, currentEpoch, currentSnapshot, previousSnapshot, account) {
  const delegations = getActiveDelegations(account)
  if (!delegations.length) return

  const lines       = []
  const incidencias = []
  const comisiones  = []

  // Estado actual de validadores — usamos el snapshot ACTUAL
  const currentValidatorList  = currentSnapshot?.validatorList  ?? []
  // Comisiones anteriores — usamos el snapshot ANTERIOR
  const previousValidatorList = previousSnapshot?.validatorList ?? []

  // Validadores con incidencias (inactivo o en jail) — estado ACTUAL
  for (const d of delegations) {
    const v = currentValidatorList.find(v => v.address === d.validatorAddr)
    if (!v) continue
    if (v.jailed) {
      incidencias.push({ name: d.validatorName || shortAddr(d.validatorAddr), balance: d.balance, estado: 'en jail' })
    } else if (v.inactive) {
      incidencias.push({ name: d.validatorName || shortAddr(d.validatorAddr), balance: d.balance, estado: 'inactivo' })
    }
  }

  // Cambios de comisión — comparar snapshot ANTERIOR con estado ACTUAL
  for (const d of delegations) {
    const prevValidator = previousValidatorList.find(v => v.address === d.validatorAddr)
    if (!prevValidator) continue

    const currValidator = currentValidatorList.find(v => v.address === d.validatorAddr)
    if (!currValidator) continue

    if (currValidator.commission === prevValidator.commission) continue

    const prevPct = (prevValidator.commission / 100).toFixed(2)
    const currPct = (currValidator.commission / 100).toFixed(2)
    const arrow   = currValidator.commission > prevValidator.commission ? '↑' : '↓'
    comisiones.push({
      name:    d.validatorName || shortAddr(d.validatorAddr),
      balance: d.balance,
      prevPct, currPct, arrow
    })
  }

  if (incidencias.length === 0 && comisiones.length === 0) return

  lines.push(`📊 <b>TU RESUMEN PERSONAL — Época ${currentEpoch}</b>`)
  lines.push(`Wallet: <code>${escapeHtml(kleverAddress)}</code>\n`)

  if (incidencias.length > 0) {
    lines.push(`⚠️ <b>Validadores con incidencias:</b>`)
    for (const v of incidencias) {
      lines.push(`  • ${escapeHtml(v.name)} — ${escapeHtml(fmtKlv(v.balance))} <i>(${v.estado})</i>`)
    }
    lines.push('')
  }

  if (comisiones.length > 0) {
    lines.push(`📉 <b>Cambios de comisión:</b>`)
    for (const v of comisiones) {
      lines.push(`  • <b>${escapeHtml(v.name)}</b> — ${escapeHtml(fmtKlv(v.balance))}`)
      lines.push(`    ${v.prevPct}% → ${v.currPct}% ${v.arrow}`)
    }
    lines.push('')
  }

  lines.push(`<i>Desna · La wallet que te entiende</i>`)

  await bot.telegram.sendMessage(telegramId, lines.join('\n'), { parse_mode: 'HTML' })
}

// ─── Ejecutar todas las alertas en lotes ─────────────────────────────────────

const BATCH_SIZE     = 10
const BATCH_DELAY_MS = 1000

async function processUserAlerts(bot, telegramId, kleverAddress, currentEpoch, currentSnapshot, previousSnapshot) {
  const account = await fetchAccountData(kleverAddress)
  if (!account) return

  await Promise.all([
    checkKlvStakingAlert(bot, telegramId, kleverAddress, currentEpoch, account),
    checkKlvAllowanceAlert(bot, telegramId, kleverAddress, currentEpoch),
    checkCommissionAlerts(bot, telegramId, kleverAddress, previousSnapshot, account),
    buildPersonalSummary(bot, telegramId, kleverAddress, currentEpoch, currentSnapshot, previousSnapshot, account),
  ])
}

async function runPersonalAlerts(pool, bot, currentEpoch, currentSnapshot, previousSnapshot) {
  const res = await pool.query(`
    SELECT bs.telegram_id, bw.klever_address
    FROM bot_subscribers bs
    JOIN bot_wallets bw ON bs.telegram_id = bw.telegram_id
    WHERE bs.active = TRUE
    ORDER BY bs.telegram_id, bw.created_at
  `)

  const rows = res.rows
  console.log(`[alertService] Ejecutando alertas para ${rows.length} wallet(s) en lotes de ${BATCH_SIZE}...`)

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)

    await Promise.all(
      batch.map(({ telegram_id, klever_address }) =>
        processUserAlerts(bot, telegram_id, klever_address, currentEpoch, currentSnapshot, previousSnapshot)
          .catch(err => console.error(`[alertService] Error ${klever_address}:`, err.message))
      )
    )

    // Pausa entre lotes para no saturar la API
    if (i + BATCH_SIZE < rows.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS))
    }

    console.log(`[alertService] Lote ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(rows.length / BATCH_SIZE)} completado`)
  }

  console.log('[alertService] Alertas personalizadas completadas')
}

// ─── Resumen de delegaciones para /wallet y /estado ──────────────────────────

function groupDelegations(delegations) {
  const grouped = {}
  for (const d of delegations) {
    const key = d.validatorAddr
    if (!grouped[key]) {
      grouped[key] = { ...d, balance: 0 }
    }
    grouped[key].balance += d.balance
  }
  return Object.values(grouped).sort((a, b) => b.balance - a.balance)
}

async function getDelegationsSummary(kleverAddress) {
  const account = await fetchAccountData(kleverAddress)
  if (!account) return null

  const klvAsset        = account.assets?.KLV
  const kfiAsset        = account.assets?.KFI
  const frozenKlv       = (klvAsset?.frozenBalance ?? 0) / 1_000_000
  const frozenKfi       = (kfiAsset?.frozenBalance ?? 0) / 1_000_000
  const lastClaimKlv    = klvAsset?.lastClaim?.epoch ?? 0
  const lastClaimKfi    = kfiAsset?.lastClaim?.epoch ?? 0
  const delegations     = groupDelegations(getActiveDelegations(account))

  return { delegations, frozenKlv, frozenKfi, lastClaimKlv, lastClaimKfi }
}

module.exports = { runPersonalAlerts, getDelegationsSummary }
