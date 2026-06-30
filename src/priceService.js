/**
 * priceService.js
 *
 * Precio de KLV en USD con cache, para cotizar Desna+. La FUENTE está
 * desacoplada: hoy CoinGecko; el día que confirmes una fuente Klever-nativa
 * (kleverscan, o un campo de precio en /assets/KLV), solo cambias fetchKlvUsd().
 *
 * Cache de 60s: evita machacar el rate limit de CoinGecko y da precios estables
 * dentro de la ventana de validez del quote. Si la red falla, sirve el último
 * precio bueno conocido en vez de romper el cobro.
 *
 * CommonJS + fetch global (Node 18+). Si tu backend es ESM/TS, cambia
 * require/module.exports por import/export.
 */

const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price?ids=klever&vs_currencies=usd'
const TTL_MS    = 60_000

let _cache = { price: 0, ts: 0 }

/** Lectura cruda de la fuente. Cambia SOLO esto para usar otra fuente. */
async function fetchKlvUsd() {
  const res = await fetch(COINGECKO)
  if (!res.ok) throw new Error(`coingecko HTTP ${res.status}`)
  const data  = await res.json()
  const price = data?.klever?.usd
  if (typeof price !== 'number' || !(price > 0)) throw new Error('precio KLV inválido')
  return price
}

/**
 * Precio KLV/USD con cache de 60s. Si la red falla pero hay un precio previo,
 * lo devuelve; solo lanza si nunca se ha podido leer un precio.
 */
async function getKlvUsd() {
  const now = Date.now()
  if (_cache.price > 0 && now - _cache.ts < TTL_MS) return _cache.price
  try {
    const price = await fetchKlvUsd()
    _cache = { price, ts: now }
    return price
  } catch (e) {
    if (_cache.price > 0) return _cache.price
    throw e
  }
}

module.exports = { getKlvUsd }
