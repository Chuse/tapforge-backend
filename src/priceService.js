/**
 * priceService.js
 *
 * Precio de KLV y KFI en USD con cache, para cotizar Desna+ y la tesorería.
 * La FUENTE está desacoplada: hoy CoinGecko; el día que confirmes una fuente
 * Klever-nativa (kleverscan, o un campo de precio en /assets/{id}), solo
 * cambias fetchUsd().
 *
 * Cache de 60s POR ID: evita machacar el rate limit de CoinGecko y da precios
 * estables dentro de la ventana de validez del quote. Si la red falla, sirve
 * el último precio bueno conocido de ESE id en vez de romper el cobro.
 *
 * CommonJS + fetch global (Node 18+). Si tu backend es ESM/TS, cambia
 * require/module.exports por import/export.
 */

const COINGECKO_IDS = { klv: 'klever', kfi: 'klever-finance' }
const TTL_MS = 60_000

// Cache separado por id de CoinGecko: { klever: {price, ts}, 'klever-finance': {price, ts} }
const _cache = {}

/** Lectura cruda de la fuente para un id de CoinGecko dado. */
async function fetchUsd(coingeckoId) {
  const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=usd`)
  if (!res.ok) throw new Error(`coingecko HTTP ${res.status} (${coingeckoId})`)
  const data  = await res.json()
  const price = data?.[coingeckoId]?.usd
  if (typeof price !== 'number' || !(price > 0)) throw new Error(`precio inválido para ${coingeckoId}`)
  return price
}

/**
 * Precio USD con cache de 60s para un id de CoinGecko. Si la red falla pero
 * hay un precio previo para ese id, lo devuelve; solo lanza si nunca se ha
 * podido leer un precio para ese id.
 */
async function getUsd(coingeckoId) {
  const now = Date.now()
  const entry = _cache[coingeckoId]
  if (entry && entry.price > 0 && now - entry.ts < TTL_MS) return entry.price
  try {
    const price = await fetchUsd(coingeckoId)
    _cache[coingeckoId] = { price, ts: now }
    return price
  } catch (e) {
    if (entry && entry.price > 0) return entry.price
    throw e
  }
}

/** Precio KLV/USD. Firma sin cambios respecto a la versión original. */
async function getKlvUsd() {
  return getUsd(COINGECKO_IDS.klv)
}

/** Precio KFI/USD — mismo patrón de cache y fallback que getKlvUsd(). */
async function getKfiUsd() {
  return getUsd(COINGECKO_IDS.kfi)
}

module.exports = { getKlvUsd, getKfiUsd }
