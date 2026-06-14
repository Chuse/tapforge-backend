/**
 * alertService.js
 * Alertas personalizadas por usuario al cierre de cada época
 * - Recompensas KLV próximas a caducar
 * - Cambio de comisión en validadores delegados
 */

const KLEVER_API       = 'https://api.mainnet.klever.org'
const MAX_CLAIM_EPOCHS = parseInt(process.env.MAX_CLAIM_EPOCHS ?? '100')
const CLAIM_WARN_EPOCHS = parseInt(process.env.CLAIM_WARN_EPOCHS ?? '10')

// ─── Leer delegaciones y estado de cuenta ────────────────────────────────────

async function fetchAccountData(kleverAddress) {
  const res  = await fetch(`${KLEVER_API}/v1.0/address/${kleverAddress}`)
  const json = await res.json()
  if (json.error || !json.data?.account) return null
  return json.data.account
}

// Extraer buckets KLV activos con delegación
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

// Épocas desde el último claim de KLV
function getEpochsSinceLastClaim(account, currentEpoch) {
  const klvAsset = account.assets?.KLV
  if (!klvAsset) return null
  const lastClaimEpoch = klvAsset.lastClaim?.epoch ?? 0
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

    if (epochsRemaining <= CLAIM_WARN_EPOCHS && epochsRemaining > 0) {
      const hoursRemaining = epochsRemaining * 6
      await bot.telegram.sendMessage(
        telegramId,
        `⚠️ <b>Recompensas KLV próximas a caducar</b>\n\n` +
        `Te quedan <b>${epochsRemaining} épocas</b> (~${hoursRemaining}h) para reclamar tus recompensas KLV.\n\n` +
        `Último claim: época <b>${currentEpoch - epochsSince}</b>\n` +
        `Caduca en: época <b>${currentEpoch - epochsSince + MAX_CLAIM_EPOCHS}</b>\n\n` +
        `Reclama cuanto antes desde Desna Wallet o KleverScan para no perderlas.`,
        { parse_mode: 'HTML' }
      )
    }
  } catch (err) {
    console.error(`[alertService] Error reward alert ${telegramId}:`, err.message)
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
      // Buscar el validador en snapshot anterior
      const prevValidator = previousSnapshot.validatorList.find(
        v => v.address === delegation.validatorAddr
      )
      if (!prevValidator) continue

      // Buscar comisión actual en la API
      const res  = await fetch(`${KLEVER_API}/v1.0/validator/${delegation.validatorAddr}`)
      const json = await res.json()
      const currCommission = json?.data?.validator?.commission ?? null
      if (currCommission === null) continue

      const prevCommission = prevValidator.commission
      if (currCommission === prevCommission) continue

      const prevPct = (prevCommission / 100).toFixed(2)
      const currPct = (currCommission / 100).toFixed(2)
      const change  = currCommission > prevCommission ? '📈 subió' : '📉 bajó'
      const name    = escapeHtml(delegation.validatorName || delegation.validatorAddr.slice(0, 10) + '...')

      await bot.telegram.sendMessage(
        telegramId,
        `🔔 <b>Cambio de comisión en tu validador</b>\n\n` +
        `El validador <b>${name}</b> al que tienes <b>${delegation.balance.toFixed(2)} KLV</b> delegados\n` +
        `${change} su comisión:\n\n` +
        `  Antes: <b>${prevPct}%</b>\n` +
        `  Ahora: <b>${currPct}%</b>\n\n` +
        `Puedes redelegar desde Desna Wallet si lo consideras oportuno.`,
        { parse_mode: 'HTML' }
      )
    }
  } catch (err) {
    console.error(`[alertService] Error commission alert ${telegramId}:`, err.message)
  }
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// ─── Ejecutar todas las alertas para todos los suscriptores ──────────────────

async function runPersonalAlerts(pool, bot, currentEpoch, previousSnapshot) {
  const res = await pool.query(
    'SELECT telegram_id, klever_address FROM bot_subscribers WHERE active = TRUE AND klever_address IS NOT NULL'
  )

  console.log(`[alertService] Ejecutando alertas para ${res.rows.length} suscriptores...`)

  for (const row of res.rows) {
    const { telegram_id, klever_address } = row

    // Alertas en paralelo por usuario pero secuencial entre usuarios
    await Promise.all([
      checkRewardAlert(bot, telegram_id, klever_address, currentEpoch),
      checkCommissionAlerts(bot, telegram_id, klever_address, previousSnapshot),
    ])
  }

  console.log('[alertService] Alertas personalizadas completadas')
}

// ─── Consulta de delegaciones para /wallet ───────────────────────────────────

async function getDelegationsSummary(kleverAddress) {
  const account = await fetchAccountData(kleverAddress)
  if (!account) return null

  const delegations    = getActiveDelegations(account)
  const klvAsset       = account.assets?.KLV
  const frozenBalance  = (klvAsset?.frozenBalance ?? 0) / 1_000_000
  const lastClaimEpoch = klvAsset?.lastClaim?.epoch ?? 0

  return { delegations, frozenBalance, lastClaimEpoch }
}

module.exports = { runPersonalAlerts, getDelegationsSummary }
