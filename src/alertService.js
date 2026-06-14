/**
 * alertService.js
 * Alertas personalizadas por usuario al cierre de cada época
 * - Recompensas KLV próximas a caducar
 * - Cambio de comisión en validadores delegados
 * Soporta múltiples wallets por usuario (máx 3)
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

// ─── Leer datos de cuenta ─────────────────────────────────────────────────────

async function fetchAccountData(kleverAddress) {
  const res  = await fetch(`${KLEVER_API}/v1.0/address/${kleverAddress}`)
  const json = await res.json()
  if (json.error || !json.data?.account) return null
  return json.data.account
}

// Buckets KLV activos con delegación
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

// Épocas desde el último claim KLV
function getEpochsSinceLastClaim(account, currentEpoch) {
  const lastClaimEpoch = account.assets?.KLV?.lastClaim?.epoch ?? 0
  if (lastClaimEpoch === 0) return null
  return currentEpoch - lastClaimEpoch
}

// ─── Alerta de recompensas ────────────────────────────────────────────────────

async function checkRewardAlert(bot, telegramId, kleverAddress, currentEpoch) {
  try {
    const account = await fetchAccountData(kleverAddress)
    if (!account) return

    const epochsSince = getEpochsSinceLastClaim(account, currentEpoch)
    if (epochsSince === null) return

    const epochsRemaining = MAX_CLAIM_EPOCHS - epochsSince
    if (epochsRemaining > CLAIM_WARN_EPOCHS || epochsRemaining <= 0) return

    const hoursRemaining = epochsRemaining * 6
    const label          = shortAddr(kleverAddress)

    await bot.telegram.sendMessage(
      telegramId,
      `⚠️ <b>Recompensas KLV próximas a caducar</b>\n\n` +
      `Wallet: <code>${escapeHtml(kleverAddress)}</code>\n\n` +
      `Te quedan <b>${epochsRemaining} épocas</b> (~${hoursRemaining}h) para reclamar tus recompensas KLV.\n\n` +
      `Último claim: época <b>${currentEpoch - epochsSince}</b>\n` +
      `Caduca en: época <b>${currentEpoch - epochsSince + MAX_CLAIM_EPOCHS}</b>\n\n` +
      `Reclama cuanto antes desde Desna Wallet para no perderlas.`,
      { parse_mode: 'HTML' }
    )
  } catch (err) {
    console.error(`[alertService] Error reward alert ${telegramId} ${kleverAddress}:`, err.message)
  }
}

// ─── Alerta de cambio de comisión ────────────────────────────────────────────

async function checkCommissionAlerts(bot, telegramId, kleverAddress, previousSnapshot) {
  if (!previousSnapshot?.validatorList?.length) return

  try {
    const account = await fetchAccountData(kleverAddress)
    if (!account) return

    const delegations = getActiveDelegations(account)
    if (!delegations.length) return

    for (const delegation of delegations) {
      const prevValidator = previousSnapshot.validatorList.find(
        v => v.address === delegation.validatorAddr
      )
      if (!prevValidator) continue

      // Leer comisión actual
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
    }
  } catch (err) {
    console.error(`[alertService] Error commission alert ${telegramId} ${kleverAddress}:`, err.message)
  }
}

// ─── Ejecutar alertas para todos los suscriptores ────────────────────────────

async function runPersonalAlerts(pool, bot, currentEpoch, previousSnapshot) {
  // Obtener todos los suscriptores activos con sus wallets
  const res = await pool.query(`
    SELECT bs.telegram_id, bw.klever_address
    FROM bot_subscribers bs
    JOIN bot_wallets bw ON bs.telegram_id = bw.telegram_id
    WHERE bs.active = TRUE
  `)

  console.log(`[alertService] Ejecutando alertas para ${res.rows.length} wallet(s)...`)

  for (const row of res.rows) {
    const { telegram_id, klever_address } = row
    await Promise.all([
      checkRewardAlert(bot, telegram_id, klever_address, currentEpoch),
      checkCommissionAlerts(bot, telegram_id, klever_address, previousSnapshot),
    ])
  }

  console.log('[alertService] Alertas personalizadas completadas')
}

// ─── Resumen de delegaciones para /wallet ────────────────────────────────────

async function getDelegationsSummary(kleverAddress) {
  const account = await fetchAccountData(kleverAddress)
  if (!account) return null

  const klvAsset       = account.assets?.KLV
  const frozenBalance  = (klvAsset?.frozenBalance ?? 0) / 1_000_000
  const lastClaimEpoch = klvAsset?.lastClaim?.epoch ?? 0
  const delegations    = getActiveDelegations(account)

  return { delegations, frozenBalance, lastClaimEpoch }
}

module.exports = { runPersonalAlerts, getDelegationsSummary }
