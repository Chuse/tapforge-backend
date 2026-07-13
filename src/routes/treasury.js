/**
 * routes/treasury.js
 * Transparencia pública de la tesorería KFI de Desna+.
 *
 * GET /treasury/kfi → balance, KFI en staking y registro de compras/staking/
 *                      claims, todo leído directamente de la cadena Klever.
 *
 * ⚠️ ANTES DE DESPLEGAR: los valores de CONTRACT_TYPE.FREEZE / CLAIM / SWAP
 * están sin confirmar empíricamente (a diferencia de AssetTrigger=11, que sí
 * se verificó contra testnet). Hay que ejecutar un swap, un freeze y un claim
 * reales en testnet y mirar el campo `contract[].type` de la tx resultante
 * para fijar los números correctos — igual que se hizo para AssetTrigger.
 * Mientras tanto este endpoint puede devolver ledger/monthly vacíos aunque
 * haya movimientos, sin que eso rompa `totals.kfi_staked` (que sale de
 * /address, no del historial de tx).
 */

const express = require('express')
const router  = express.Router()
const { getKlvUsd, getKfiUsd } = require('../priceService')

// ─── Config (env) ──────────────────────────────────────────────────────────
const KLEVER_API       = (process.env.KLEVER_API ?? 'https://api.mainnet.klever.org/v1.0').trim()
const KLEVER_NODE      = (process.env.KLEVER_NODE ?? 'https://node.mainnet.klever.org').trim()
const TREASURY_ADDRESS = (process.env.KFI_TREASURY_ADDRESS ?? '').trim()
const KFI_ASSET_ID     = (process.env.KFI_ASSET_ID ?? 'KFI').trim()
const KFI_PRECISION    = Number(process.env.KFI_PRECISION ?? 6) // ⚠️ confirmar precisión real del KDA KFI (no todos usan 6)
const CACHE_TTL_MS     = Number(process.env.TREASURY_CACHE_TTL ?? 300) * 1000
const TX_LIMIT         = Number(process.env.TREASURY_TX_LIMIT ?? 200)

// Contract types de Klever — ⚠️ SIN VERIFICAR, ver nota de cabecera
const CONTRACT_TYPE = {
  FREEZE: 4,
  CLAIM:  8,
  SWAP:   24,
}

let _cache = { data: null, ts: 0 }

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Klever API ${res.status}: ${url}`)
  return res.json()
}

/** Balance líquido + buckets de staking del KFI en la wallet de tesorería. */
async function getKfiAccountState() {
  // ⚠️ Forma de respuesta asumida a partir del patrón de otros endpoints de
  // /address confirmados en el proyecto; verificar `assets[KFI_ASSET_ID]`
  // contra una respuesta real antes de confiar en el shape.
  const json   = await fetchJson(`${KLEVER_API}/address/${TREASURY_ADDRESS}`)
  const asset  = json?.data?.account?.assets?.[KFI_ASSET_ID] ?? {}
  const scale  = 10 ** KFI_PRECISION

  const buckets = Array.isArray(asset.buckets) ? asset.buckets : []
  const staked  = buckets.reduce((sum, b) => sum + Number(b.balance ?? 0), 0) / scale
  const liquid  = Number(asset.balance ?? 0) / scale

  return { liquid, staked, bucketsCount: buckets.length }
}

/** Historial de transacciones de la wallet de tesorería, sin filtrar aún. */
async function getTreasuryTxHistory() {
  const json = await fetchJson(
    `${KLEVER_NODE}/transaction/list?address=${TREASURY_ADDRESS}&limit=${TX_LIMIT}`
  )
  return Array.isArray(json?.data?.transactions) ? json.data.transactions : []
}

function monthKeyFromTx(tx) {
  // Klever suele dar timestamp en segundos; ajustar *1000 si tu respuesta real viene en ms.
  const d = new Date(Number(tx.timestamp) * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Recorre las tx y separa compras (swap), staking (freeze) y claims. */
function buildLedgerAndMonthly(txs) {
  const ledger = []
  const monthlyMap = new Map()
  const scale = 10 ** KFI_PRECISION

  for (const tx of txs) {
    const contracts = Array.isArray(tx.contract) ? tx.contract : []
    const month = monthKeyFromTx(tx)

    for (const c of contracts) {
      const type = c.type ?? c.Type
      const param = c.parameter ?? c.Parameter ?? {}

      if (type === CONTRACT_TYPE.SWAP) {
        // ⚠️ Nombres de campo asumidos (amountIn/amountOut) — confirmar
        // contra la respuesta real de un swap KLV→KFI en testnet.
        const klvIn  = Number(param.amountIn ?? 0)
        const kfiOut = Number(param.amountOut ?? 0) / scale

        ledger.push({
          date: tx.timestamp,
          type: 'buy',
          detail: `${klvIn} KLV → ${kfiOut.toFixed(2)} KFI`,
          tx: tx.hash ?? tx.txHash,
        })

        const m = monthlyMap.get(month) ?? { month, klv_converted: 0, kfi_acquired: 0 }
        m.klv_converted += klvIn
        m.kfi_acquired  += kfiOut
        monthlyMap.set(month, m)
      }

      if (type === CONTRACT_TYPE.FREEZE && (param.assetId ?? param.AssetId) === KFI_ASSET_ID) {
        const amount = Number(param.amount ?? 0) / scale
        ledger.push({
          date: tx.timestamp,
          type: 'stake',
          detail: `Freeze de ${amount.toFixed(2)} KFI`,
          tx: tx.hash ?? tx.txHash,
        })
      }

      if (type === CONTRACT_TYPE.CLAIM) {
        ledger.push({
          date: tx.timestamp,
          type: 'claim',
          detail: 'Claim de recompensas de staking',
          tx: tx.hash ?? tx.txHash,
        })
      }
    }
  }

  ledger.sort((a, b) => Number(b.date) - Number(a.date))
  const monthly = [...monthlyMap.values()].sort((a, b) => a.month.localeCompare(b.month))
  return { ledger, monthly }
}

// ─── GET /treasury/kfi ──────────────────────────────────────────────────────
router.get('/kfi', async (req, res) => {
  try {
    if (!TREASURY_ADDRESS) throw new Error('KFI_TREASURY_ADDRESS no configurada')

    const now = Date.now()
    if (_cache.data && now - _cache.ts < CACHE_TTL_MS) {
      return res.json(_cache.data)
    }

    const [account, txs, klvUsd, kfiUsd] = await Promise.all([
      getKfiAccountState(),
      getTreasuryTxHistory(),
      getKlvUsd().catch(() => 0),
      getKfiUsd().catch(() => 0),
    ])

    const { ledger, monthly } = buildLedgerAndMonthly(txs)

    const payload = {
      address: TREASURY_ADDRESS,
      updated_at: new Date(now).toISOString(),
      prices: { klv_usd: klvUsd, kfi_usd: kfiUsd },
      totals: {
        klv_committed:  monthly.reduce((s, m) => s + m.klv_converted, 0),
        kfi_bought:     monthly.reduce((s, m) => s + m.kfi_acquired, 0),
        kfi_staked:     account.staked,
        kfi_liquid:     account.liquid,
        buckets_count:  account.bucketsCount,
      },
      monthly,
      ledger: ledger.slice(0, 50),
    }

    _cache = { data: payload, ts: now }
    res.json(payload)
  } catch (e) {
    console.error('[treasury] Error:', e.message)
    // Igual que priceService: si la API de Klever falla, servimos el último
    // dato bueno conocido en vez de romper la página pública.
    if (_cache.data) return res.json(_cache.data)
    res.status(503).json({ error: 'No se pudo leer la tesorería ahora mismo' })
  }
})

module.exports = router
