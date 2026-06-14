/**
 * alertService.js
 * Alertas personalizadas por usuario al cierre de cada época
 * - Recompensas KLV Staking próximas a caducar (lastClaim del asset)
 * - Recompensas KLV Allowance próximas a caducar (última tx AllowanceClaim)
 * - Recompensas KFI próximas a caducar (lastClaim del asset KFI)
 * - Cambio de comisión en validadores delegados
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
    `Pendiente: <b>${pendingKlv.toFixed(6)} KLV</b>\n` +
    `Te quedan <b>${epochsRemaining} épocas</b> (~${epochsToHours(epochsRemaining)}h) para reclamar.\n\n` +
    `Último StakingClaim: época <b>${lastClaimEpoch}</b>\n` +
    `Caduca en: época <b>${lastClaimEpoch + MAX_CLAIM_EPOCHS}</b>\n\n` +
    `Reclama cuanto antes desde Desna Wallet para no perder tus recompensas.`,
    { parse_mode: 'HTML' }
  )
}

// ─── Alerta de recompensas KLV Allowance (delegación) ────────────────────────

async function checkKlvAllowanceAlert(bot, telegramId, kleverAddress, currentEpoch) {
  const lastAllowanceEpoch = await fetchLastAllowanceClaimEpoch(kleverAddress)
  if (lastAllowanceEpoch === null) return

  const epochsSince     = currentEpoch - lastAllowanceEpoch
  const epochsRemaining = MAX_CLAIM_EPOCHS - epochsSince
  if (epochsRemaining > CLAIM_WARN_EPOCHS || epochsRemaining <= 0) return

  // Obtener importe pendiente
  let pendingKlv = 0
  try {
    const res  = await fetch(`${KLEVER_API}/v1.0/address/${kleverAddress}/allowance`)
    const json = await res.json()
    pendingKlv = (json?.data?.result?.allowance ?? 0) / 1_000_000
  } catch {}

  await bot.telegram.sendMessage(
    telegramId,
    `⚠️ <b>Recompensas de Delegación KLV próximas a caducar</b>\n\n` +
    `Wallet: <code>${escapeHtml(kleverAddress)}</code>\n\n` +
    `Pendiente: <b>${pendingKlv.toFixed(6)} KLV</b>\n` +
    `Te quedan <b>${epochsRemaining} épocas</b> (~${epochsToHours(epochsRemaining)}h) para reclamar.\n\n` +
    `Último AllowanceClaim: época <b>${lastAllowanceEpoch}</b>\n` +
    `Caduca en: época <b>${lastAllowanceEpoch + MAX_CLAIM_EPOCHS}</b>\n\n` +
    `Reclama cuanto antes desde Desna Wallet para no perder tus recompensas de delegación.`,
    { parse_mode: 'HTML' }
  )
}

// ─── Alerta de recompensas KFI ───────────────────────────────────────────────

async function checkKfiAlert(bot, telegramId, kleverAddress, currentEpoch, account) {
  const kfiAsset = account.assets?.KFI
  if (!kfiAsset) return

  const lastClaimEpoch = kfiAsset.lastClaim?.epoch ?? 0
  if (lastClaimEpoch === 0) return

  const epochsSince     = currentEpoch - lastClaimEpoch
  const epochsRemaining = MAX_CLAIM_EPOCHS - epochsSince
  if (epochsRemaining > CLAIM_WARN_EPOCHS || epochsRemaining <= 0) return

  // Obtener importe pendiente KFI
  let pendingKfi = 0
  try {
    const res  = await fetch(`${KLEVER_API}/v1.0/address/${kleverAddress}/allowance`)
    const json = await res.json()
    const all  = json?.data?.result?.allStakingRewards ?? []
    const kfi  = all.find(r => r.assetId === 'KFI')
    if (kfi) pendingKfi = kfi.rewards / Math.pow(10, kfi.precision ?? 6)
  } catch {}

  if (pendingKfi === 0) return

  await bot.telegram.sendMessage(
    telegramId,
    `⚠️ <b>Recompensas de KFI próximas a caducar</b>\n\n` +
    `Wallet: <code>${escapeHtml(kleverAddress)}</code>\n\n` +
    `Pendiente: <b>${pendingKfi.toFixed(6)} KFI</b>\n` +
    `Te quedan <b>${epochsRemaining} épocas</b> (~${epochsToHours(epochsRemaining)}h) para reclamar.\n\n` +
    `Último claim KFI: época <b>${lastClaimEpoch}</b>\n` +
    `Caduca en: época <b>${lastClaimEpoch + MAX_CLAIM_EPOCHS}</b>\n\n` +
    `Reclama cuanto antes desde Desna Wallet para no perder tus recompensas KFI.`,
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

// ─── Ejecutar todas las alertas ───────────────────────────────────────────────

async function runPersonalAlerts(pool, bot, currentEpoch, previousSnapshot) {
  const res = await pool.query(`
    SELECT bs.telegram_id, bw.klever_address
    FROM bot_subscribers bs
    JOIN bot_wallets bw ON bs.telegram_id = bw.telegram_id
    WHERE bs.active = TRUE
  `)

  console.log(`[alertService] Ejecutando alertas para ${res.rows.length} wallet(s)...`)

  for (const row of res.rows) {
    const { telegram_id, klever_address } = row

    try {
      const account = await fetchAccountData(klever_address)
      if (!account) continue

      await Promise.all([
        checkKlvStakingAlert(bot, telegram_id, klever_address, currentEpoch, account),
        checkKlvAllowanceAlert(bot, telegram_id, klever_address, currentEpoch),
        checkKfiAlert(bot, telegram_id, klever_address, currentEpoch, account),
        checkCommissionAlerts(bot, telegram_id, klever_address, previousSnapshot, account),
      ])
    } catch (err) {
      console.error(`[alertService] Error procesando ${klever_address}:`, err.message)
    }
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
