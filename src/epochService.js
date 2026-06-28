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

function cleanTypeName(raw) {
  return raw.replace('ContractType', '').replace('Type', '').trim()
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
  const epochDurationSec = status.slotsPerEpoch * slotDurationSec

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
  let networkTotalDelegated = 0

  while (true) {
    const res  = await fetch(`${KLEVER_API}/v1.0/validator/list?limit=${limit}&page=${page}`)
    const json = await res.json()
    const list = json?.data?.validators ?? []

    // networkTotalStake viene en la primera página
    if (page === 1) {
      networkTotalDelegated = (json?.data?.networkTotalStake ?? 0) / 1_000_000
    }

    if (list.length === 0) break

    for (const v of list) {
      const listStatus   = v.list ?? ''
      const totalSuccess = v.totalValidatorSuccessRate?.numSuccess ?? 0
      const totalFailure = v.totalValidatorSuccessRate?.numFailure ?? 0
      const totalBlocks  = totalSuccess + totalFailure
      const successRate  = totalBlocks > 0 ? (totalSuccess / totalBlocks) * 100 : 0

      all.push({
        address:       v.ownerAddress ?? v.address ?? '',
        name:          v.name ?? '',
        elected:       listStatus === 'elected',
        eligible:      listStatus === 'eligible',
        jailed:        v.jailed === true || listStatus === 'jailed',
        inactive:      listStatus !== 'elected' && listStatus !== 'eligible' && listStatus !== 'jailed' && listStatus !== 'waiting',
        waiting:       listStatus === 'waiting',
        stake:         (v.totalStake ?? 0) / 1_000_000,
        commission:    v.commission ?? 0,
        listStatus,
        successRate,
        totalSuccess,
        totalFailure,
        logo:          v.logo ?? '',
      })
    }

    if (list.length < limit) break
    page++
  }

  // Validator spotlight — elegido con mejor success rate (mínimo 1000 bloques históricos)
  const spotlight = all
    .filter(v => v.elected && (v.totalSuccess + v.totalFailure) > 1000)
    .sort((a, b) => b.successRate - a.successRate)[0] ?? null

  return { validators: all, networkTotalDelegated, spotlight }
}

// ─── KLV Asset stats ──────────────────────────────────────────────────────────

async function fetchKlvAsset() {
  const res  = await fetch(`${KLEVER_API}/v1.0/assets/KLV`)
  const json = await res.json()
  const a    = json?.data?.asset ?? {}
  const div  = Math.pow(10, a.precision ?? 6)

  return {
    stakingTotal:      (a.staking?.totalStaked   ?? 0) / div,
    burned:            (a.burnedValue            ?? 0) / div,
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
  const kdaTransfers  = {}
  const kdaClaims     = {}
  const kdaFreezes    = {}
  const kdaAll        = {}
  const contractAddrs = {}

  let txCount      = 0
  let totalKAppFee = 0
  let totalBwFee   = 0
  let volumeKlv    = 0
  let mostActiveAddr = ''
  const senderCount  = {}
  let done           = false

  while (!done) {
    const res  = await fetch(`${KLEVER_API}/v1.0/transaction/list?limit=${limit}&page=${page}`)
    const json = await res.json()
    const txs  = json?.data?.transactions ?? []

    if (txs.length === 0) break

    for (const tx of txs) {
      const blockNum = tx.blockNum ?? 0
      if (blockNum < nonceStart) { done = true; break }
      if (blockNum > nonceEnd)   continue

      txCount++
      const sender = tx.sender ?? ''
      if (sender) {
        senders.add(sender)
        senderCount[sender] = (senderCount[sender] ?? 0) + 1
      }

      totalKAppFee += (tx.kAppFee      ?? 0) / 1_000_000
      totalBwFee   += (tx.bandwidthFee ?? 0) / 1_000_000

      const contracts = Array.isArray(tx.contract) ? tx.contract : []
      for (const c of contracts) {
        const rawType = c.typeString ?? TX_TYPE_MAP[c.type] ?? `Type${c.type}`
        const type    = cleanTypeName(rawType)
        contractCount[type] = (contractCount[type] ?? 0) + 1

        const param = c.parameter ?? {}

        // Volumen KLV en transfers
        if (type === 'Transfer') {
          const asset  = param.assetId ?? param.asset ?? 'KLV'
          const amount = (param.amount ?? 0) / 1_000_000
          if (asset === 'KLV') volumeKlv += amount

          const ticker = asset.split('-')[0]
          kdaTransfers[ticker] = (kdaTransfers[ticker] ?? 0) + 1
          kdaAll[ticker]       = (kdaAll[ticker]       ?? 0) + 1
        }

        // Claims
        if (type === 'Claim') {
          const asset  = param.assetId ?? 'KLV'
          const ticker = asset.split('-')[0]
          kdaClaims[ticker] = (kdaClaims[ticker] ?? 0) + 1
          kdaAll[ticker]    = (kdaAll[ticker]    ?? 0) + 1
        }

        // Freezes
        if (type === 'Freeze') {
          const asset  = param.assetId ?? 'KLV'
          const ticker = asset.split('-')[0]
          kdaFreezes[ticker] = (kdaFreezes[ticker] ?? 0) + 1
          kdaAll[ticker]     = (kdaAll[ticker]     ?? 0) + 1
        }

        // SmartContract — top contratos por dirección
        if (type === 'SmartContract') {
          const addr = param.address ?? ''
          if (addr) {
            const short = `${addr.slice(0, 6)}…${addr.slice(-4)}`
            contractAddrs[short] = (contractAddrs[short] ?? 0) + 1
          }

          // Assets en callValue
          if (Array.isArray(param.callValue)) {
            for (const cv of param.callValue) {
              if (cv.asset) {
                const ticker = cv.asset.split('-')[0]
                kdaAll[ticker] = (kdaAll[ticker] ?? 0) + 1
              }
            }
          }
        }
      }
    }

    const lastBlock = txs[txs.length - 1]?.blockNum ?? 0
    if (lastBlock < nonceStart) done = true
    page++
    if (page > 200) { console.warn('[epochService] Límite de paginación alcanzado'); break }
  }

  // Most active sender
  const mostActive = Object.entries(senderCount).sort((a, b) => b[1] - a[1])[0]
  if (mostActive) mostActiveAddr = mostActive[0]
  const mostActiveTxCount = mostActive?.[1] ?? 0

  const topContracts = Object.entries(contractCount)
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([type, count]) => ({ type, count }))

  const topKdaAll = Object.entries(kdaAll)
    .sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([asset, count]) => ({ asset, count }))

  const topKdaTransfers = Object.entries(kdaTransfers)
    .sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([asset, count]) => ({ asset, count }))

  const topKdaClaims = Object.entries(kdaClaims)
    .sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([asset, count]) => ({ asset, count }))

  const topKdaFreezes = Object.entries(kdaFreezes)
    .sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([asset, count]) => ({ asset, count }))

  const topSmartContracts = Object.entries(contractAddrs)
    .sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([addr, count]) => ({ addr, count }))

  return {
    txCount,
    dau: senders.size,
    totalKAppFee,
    totalBwFee,
    burnedFee: totalBwFee / 2,
    volumeKlv,
    mostActiveAddr,
    mostActiveTxCount,
    topContracts,
    topKdas: topKdaAll,
    topKdaTransfers,
    topKdaClaims,
    topKdaFreezes,
    topSmartContracts,
  }
}

// ─── Recopilación completa ────────────────────────────────────────────────────

async function collectEpochSnapshot() {
  console.log('[epochService] Iniciando recopilación de época...')

  const status = await getNodeStatus()
  const range  = getPreviousEpochRange(status)

  console.log(`[epochService] Época ${range.epochNumber} | Bloques ${range.nonceStart}-${range.nonceEnd}`)

  const [validatorData, klvAsset, price, txStats] = await Promise.all([
    fetchValidators(),
    fetchKlvAsset(),
    fetchKlvPrice(),
    fetchEpochTxStats(range.nonceStart, range.nonceEnd),
  ])

  const { validators, networkTotalDelegated, spotlight } = validatorData

  return {
    epochNumber:          range.epochNumber,
    nonceStart:           range.nonceStart,
    nonceEnd:             range.nonceEnd,
    timestampStart:       range.tsStart,
    timestampEnd:         range.tsEnd,
    stakingTotal:         klvAsset.stakingTotal,
    burned:               klvAsset.burned,
    circulatingSupply:    klvAsset.circulatingSupply,
    networkTotalDelegated,
    klvPriceUsdt:         price.price,
    klvPriceChange24h:    price.change24h,
    txCount:              txStats.txCount,
    dau:                  txStats.dau,
    totalKAppFee:         txStats.totalKAppFee,
    totalBwFee:           txStats.totalBwFee,
    burnedFee:            txStats.burnedFee,
    volumeKlv:            txStats.volumeKlv,
    mostActiveAddr:       txStats.mostActiveAddr,
    mostActiveTxCount:    txStats.mostActiveTxCount,
    validatorList:        validators,
    validatorsTotal:      validators.length,
    validatorsElected:    validators.filter(v => v.elected).length,
    validatorsEligible:   validators.filter(v => v.eligible).length,
    validatorsJailed:     validators.filter(v => v.jailed).length,
    validatorsInactive:   validators.filter(v => v.inactive).length,
    validatorsWaiting:    validators.filter(v => v.waiting).length,
    spotlight,
    topContracts:         txStats.topContracts,
    topKdas:              txStats.topKdas,
    topKdaTransfers:      txStats.topKdaTransfers,
    topKdaClaims:         txStats.topKdaClaims,
    topKdaFreezes:        txStats.topKdaFreezes,
    topSmartContracts:    txStats.topSmartContracts,
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
      snapshot.epochNumber, snapshot.nonceStart, snapshot.nonceEnd,
      snapshot.timestampStart, snapshot.timestampEnd,
      snapshot.stakingTotal, snapshot.burned, snapshot.circulatingSupply,
      snapshot.klvPriceUsdt, snapshot.klvPriceChange24h,
      snapshot.txCount, snapshot.dau,
      JSON.stringify(snapshot.validatorList),
      snapshot.validatorsTotal, snapshot.validatorsElected,
      snapshot.validatorsJailed, snapshot.validatorsInactive, snapshot.validatorsWaiting,
      JSON.stringify(snapshot.topContracts), JSON.stringify(snapshot.topKdas),
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
    epochNumber:      r.epoch_number,
    stakingTotal:     parseFloat(r.staking_total),
    burned:           parseFloat(r.burned),
    circulatingSupply: parseFloat(r.circulating_supply),
    klvPriceUsdt:     parseFloat(r.klv_price_usdt),
    klvPriceChange24h: parseFloat(r.klv_price_change_24h),
    txCount:          r.tx_count,
    dau:              r.dau,
    validatorList:    r.validator_list   ?? [],
    validatorsElected: r.validators_elected,
    validatorsJailed:  r.validators_jailed,
    topContracts:     r.top_contracts ?? [],
    topKdas:          r.top_kdas      ?? [],
  }
}

// ─── Diff de validadores entre dos épocas ────────────────────────────────────

/**
 * Compara dos listas de validadores (current vs previous) y devuelve solo los
 * que cambiaron algo relevante. Función pura, agnóstica del usuario y de la
 * unidad de comisión (pasa los valores crudos tal cual se guardaron).
 */
function diffValidators(currentList, previousList) {
  const prevByAddr = new Map((previousList ?? []).map(v => [v.address, v]))
  const changes = []

  for (const curr of currentList ?? []) {
    const prev = prevByAddr.get(curr.address)
    if (!prev) continue // validador nuevo: no es un "cambio" para un delegador existente

    const becameJailed     = !prev.jailed  && !!curr.jailed
    const becameDeselected = !!prev.elected && !curr.elected
    const commissionPrev   = prev.commission ?? 0
    const commissionCurr   = curr.commission ?? 0
    const commissionChanged = commissionPrev !== commissionCurr

    if (!becameJailed && !becameDeselected && !commissionChanged) continue

    changes.push({
      address:         curr.address,
      name:            curr.name || '',
      commissionPrev,
      commissionCurr,
      becameJailed,
      becameDeselected,
    })
  }

  return changes
}

/**
 * Lee las dos últimas snapshots de la BD y devuelve el diff. Esto es lo que
 * consume el endpoint y la app.
 */
async function getLatestValidatorChanges(pool) {
  const res = await pool.query(
    'SELECT epoch_number, validator_list FROM bot_epoch_snapshots ORDER BY epoch_number DESC LIMIT 2'
  )
  if (res.rows.length < 2) {
    return { epoch: res.rows[0]?.epoch_number ?? null, changes: [] }
  }
  const [current, previous] = res.rows
  return {
    epoch:   current.epoch_number,
    changes: diffValidators(current.validator_list ?? [], previous.validator_list ?? []),
  }
}

module.exports = {
  collectEpochSnapshot,
  saveEpochSnapshot,
  getPreviousSnapshot,
  getNodeStatus,
  diffValidators,
  getLatestValidatorChanges,
}
