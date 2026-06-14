/**
 * epochService.js
 * Recopila todos los datos de una época cerrada
 * y los guarda en bot_epoch_snapshots
 */

const KLEVER_API  = 'https://api.mainnet.klever.org'
const KLEVER_NODE = 'https://node.mainnet.klever.org'
const COINGECKO   = 'https://api.coingecko.com/api/v3'

// ─── Mapa de tipos de contrato Klever ─────────────────────────────────────────

const TX_TYPE_MAP = {
  0:  'Transfer',
  1:  'CreateAsset',
  2:  'CreateValidator',
  3:  'ValidatorConfig',
  4:  'Freeze',
  5:  'Unfreeze',
  6:  'Delegate',
  7:  'Undelegate',
  8:  'Withdraw',
  9:  'Claim',
  10: 'Unjail',
  11: 'AssetTrigger',
  12: 'SetAccountName',
  13: 'Proposal',
  14: 'Vote',
  15: 'ConfigITO',
  16: 'SetITOPrices',
  17: 'Buy',
  18: 'Sell',
  19: 'CancelMarketOrder',
  20: 'CreateMarketplace',
  21: 'ConfigMarketplace',
  22: 'UpdateAccountPermission',
  23: 'Deposit',
  24: 'ITOTrigger',
  63: 'SmartContract',
}

// ─── Node status ──────────────────────────────────────────────────────────────

async function getNodeStatus() {
  const res  = await fetch(`${KLEVER_NODE}/node/status`)
  const json = await res.json()
  const m    = json.data.metrics

  return {
    epochNumber:       m.klv_epoch_number,
    nonceAtEpochStart: m.klv_nonce_at_epoch_start,
    slotAtEpochStart:  m.klv_slot_at_epoch_start,
    currentSlot:       m.klv_current_slot,
    currentSlotTs:     m.klv_current_slot_timestamp,
    slotsPerEpoch:     m.klv_slots_per_epoch,
    slotDuration:      m.klv_slot_duration,
    startTime:         m.klv_start_time,
  }
}

// ─── Rango de la época anterior ───────────────────────────────────────────────

function getPreviousEpochRange(status) {
  const slotDurationSec  = status.slotDuration / 1000
  const epochDurationSec = status.slotsPerEpoch * slotDurationSec // 21600s = 6h

  const nonceStart = status.nonceAtEpochStart - status.slotsPerEpoch
  const nonceEnd   = status.nonceAtEpochStart - 1

  const tsEndSec   = status.currentSlotTs - epochDurationSec
  const tsStartSec = tsEndSec - epochDurationSec

  return {
    epochNumber: status.epochNumber - 1,
    nonceStart,
    nonceEnd,
    tsStart: new Date(tsStartSec * 1000),
    tsEnd:   new Date(tsEndSec   * 1000),
  }
}

// ─── Validadores ──────────────────────────────────────────────────────────────

async function fetchValidators() {
  let page    = 1
  const limit = 100
  const all   = []

  while (true) {
    const res  = await fetch(`${KLEVER_API}/v1.0/validator/list?limit=${limit}&page=${page}`)
    const json = await res.json()
    const list = json?.data?.validators ?? []

    if (list.length === 0) break

    for (const v of list) {
      // El campo "list" indica el estado: "eligible", "waiting", "jailed", "new"
      const listStatus = v.list ?? ''
      all.push({
        address:    v.ownerAddress ?? v.address ?? '',
        name:       v.name ?? '',
        elected:    listStatus === 'eligible',
        jailed:     v.jailed === true || listStatus === 'jailed',
        inactive:   listStatus === 'new' || listStatus === '',
        waiting:    listStatus === 'waiting',
        stake:      v.totalStake ?? 0,
        commission: v.commission ?? 0,
        listStatus,
      })
    }

    if (list.length < limit) break
    page++
  }

  return all
}

// ─── KLV Asset stats ──────────────────────────────────────────────────────────

async function fetchKlvAsset() {
  const res  = await fetch(`${KLEVER_API}/v1.0/assets/KLV`)
  const json = await res.json()
  const a    = json?.data?.asset ?? {}

  const precision = a.precision ?? 6
  const div       = Math.pow(10, precision)

  return {
    stakingTotal:      (a.staking?.totalStaked   ?? 0) / div,
    burned:            (a.burned                 ?? 0) / div,
    circulatingSupply: (a.circulatingSupply       ?? 0) / div,
  }
}

// ─── Precio KLV ───────────────────────────────────────────────────────────────

async function fetchKlvPrice() {
  const res  = await fetch(
    `${COINGECKO}/coins/markets?vs_currency=usd&ids=klever&price_change_percentage=24h`
  )
  const json = await res.json()
  const coin = json?.[0] ?? {}

  return {
    price:     coin.current_price               ?? 0,
    change24h: coin.price_change_percentage_24h ?? 0,
  }
}

// ─── Transacciones de la época ────────────────────────────────────────────────

async function fetchEpochTxStats(nonceStart, nonceEnd) {
  const limit = 100
  let   page  = 1

  const senders       = new Set()
  const contractCount = {}
  const kdaCount      = {}
  let   txCount       = 0
  let   done          = false

  while (!done) {
    const res  = await fetch(
      `${KLEVER_API}/v1.0/transaction/list?limit=${limit}&page=${page}`
    )
    const json = await res.json()
    const txs  = json?.data?.transactions ?? []

    if (txs.length === 0) break

    for (const tx of txs) {
      const blockNum = tx.blockNum ?? 0

      if (blockNum < nonceStart) { done = true; break }
      if (blockNum > nonceEnd)   continue

      txCount++
      if (tx.sender) senders.add(tx.sender)

      const contracts = Array.isArray(tx.contract) ? tx.contract : []
      for (const c of contracts) {
        // Usar typeString si existe, si no mapear el número
        const type = c.typeString ?? TX_TYPE_MAP[c.type] ?? `Type${c.type}`
        contractCount[type] = (contractCount[type] ?? 0) + 1

        // Recopilar assets — incluye callValue para SmartContracts
        const assets = []
        if (c.parameter?.assetId) assets.push(c.parameter.assetId)
        if (c.parameter?.asset)   assets.push(c.parameter.asset)
        if (Array.isArray(c.parameter?.callValue)) {
          for (const cv of c.parameter.callValue) {
            if (cv.asset) assets.push(cv.asset)
          }
        }
        for (const asset of assets) {
          const ticker = asset.split('-')[0]
          kdaCount[ticker] = (kdaCount[ticker] ?? 0) + 1
        }
      }
    }

    const lastBlock = txs[txs.length - 1]?.blockNum ?? 0
    if (lastBlock < nonceStart) done = true

    page++

    if (page > 200) {
      console.warn('[epochService] Límite de paginación alcanzado')
      break
    }
  }

  const topContracts = Object.entries(contractCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([type, count]) => ({ type, count }))

  const topKdas = Object.entries(kdaCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([asset, count]) => ({ asset, count }))

  return { txCount, dau: senders.size, topContracts, topKdas }
}

// ─── Recopilación completa ────────────────────────────────────────────────────

async function collectEpochSnapshot() {
  console.log('[epochService] Iniciando recopilación de época...')

  const status = await getNodeStatus()
  const range  = getPreviousEpochRange(status)

  console.log(`[epochService] Época ${range.epochNumber} | Bloques ${range.nonceStart}-${range.nonceEnd}`)

  const [validators, klvAsset, price, txStats] = await Promise.all([
    fetchValidators(),
    fetchKlvAsset(),
    fetchKlvPrice(),
    fetchEpochTxStats(range.nonceStart, range.nonceEnd),
  ])

  return {
    epochNumber:        range.epochNumber,
    nonceStart:         range.nonceStart,
    nonceEnd:           range.nonceEnd,
    timestampStart:     range.tsStart,
    timestampEnd:       range.tsEnd,
    stakingTotal:       klvAsset.stakingTotal,
    burned:             klvAsset.burned,
    circulatingSupply:  klvAsset.circulatingSupply,
    klvPriceUsdt:       price.price,
    klvPriceChange24h:  price.change24h,
    txCount:            txStats.txCount,
    dau:                txStats.dau,
    validatorList:      validators,
    validatorsTotal:    validators.length,
    validatorsElected:  validators.filter(v => v.elected).length,
    validatorsJailed:   validators.filter(v => v.jailed).length,
    validatorsInactive: validators.filter(v => v.inactive).length,
    validatorsWaiting:  validators.filter(v => v.waiting).length,
    topContracts:       txStats.topContracts,
    topKdas:            txStats.topKdas,
  }
}

// ─── Persistencia ─────────────────────────────────────────────────────────────

async function saveEpochSnapshot(pool, snapshot) {
  await pool.query(
    `INSERT INTO bot_epoch_snapshots (
      epoch_number, nonce_start, nonce_end, timestamp_start, timestamp_end,
      staking_total, burned, circulating_supply,
      klv_price_usdt, klv_price_change_24h,
      tx_count, dau,
      validator_list, validators_total, validators_elected,
      validators_jailed, validators_inactive, validators_waiting,
      top_contracts, top_kdas
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
    ON CONFLICT (epoch_number) DO UPDATE SET
      staking_total        = EXCLUDED.staking_total,
      burned               = EXCLUDED.burned,
      circulating_supply   = EXCLUDED.circulating_supply,
      klv_price_usdt       = EXCLUDED.klv_price_usdt,
      klv_price_change_24h = EXCLUDED.klv_price_change_24h,
      tx_count             = EXCLUDED.tx_count,
      dau                  = EXCLUDED.dau,
      validator_list       = EXCLUDED.validator_list,
      validators_total     = EXCLUDED.validators_total,
      validators_elected   = EXCLUDED.validators_elected,
      validators_jailed    = EXCLUDED.validators_jailed,
      validators_inactive  = EXCLUDED.validators_inactive,
      validators_waiting   = EXCLUDED.validators_waiting,
      top_contracts        = EXCLUDED.top_contracts,
      top_kdas             = EXCLUDED.top_kdas`,
    [
      snapshot.epochNumber,
      snapshot.nonceStart,
      snapshot.nonceEnd,
      snapshot.timestampStart,
      snapshot.timestampEnd,
      snapshot.stakingTotal,
      snapshot.burned,
      snapshot.circulatingSupply,
      snapshot.klvPriceUsdt,
      snapshot.klvPriceChange24h,
      snapshot.txCount,
      snapshot.dau,
      JSON.stringify(snapshot.validatorList),
      snapshot.validatorsTotal,
      snapshot.validatorsElected,
      snapshot.validatorsJailed,
      snapshot.validatorsInactive,
      snapshot.validatorsWaiting,
      JSON.stringify(snapshot.topContracts),
      JSON.stringify(snapshot.topKdas),
    ]
  )
}

// ─── Snapshot anterior ────────────────────────────────────────────────────────

async function getPreviousSnapshot(pool, epochNumber) {
  const res = await pool.query(
    'SELECT * FROM bot_epoch_snapshots WHERE epoch_number = $1',
    [epochNumber - 1]
  )

  if (res.rows.length === 0) return null
  const r = res.rows[0]

  return {
    epochNumber:        r.epoch_number,
    nonceStart:         r.nonce_start,
    nonceEnd:           r.nonce_end,
    timestampStart:     r.timestamp_start,
    timestampEnd:       r.timestamp_end,
    stakingTotal:       parseFloat(r.staking_total),
    burned:             parseFloat(r.burned),
    circulatingSupply:  parseFloat(r.circulating_supply),
    klvPriceUsdt:       parseFloat(r.klv_price_usdt),
    klvPriceChange24h:  parseFloat(r.klv_price_change_24h),
    txCount:            r.tx_count,
    dau:                r.dau,
    validatorList:      r.validator_list      ?? [],
    validatorsTotal:    r.validators_total,
    validatorsElected:  r.validators_elected,
    validatorsJailed:   r.validators_jailed,
    validatorsInactive: r.validators_inactive,
    validatorsWaiting:  r.validators_waiting,
    topContracts:       r.top_contracts ?? [],
    topKdas:            r.top_kdas      ?? [],
  }
}

module.exports = {
  collectEpochSnapshot,
  saveEpochSnapshot,
  getPreviousSnapshot,
  getNodeStatus,
}
