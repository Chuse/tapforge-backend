/**
 * routes/plus.js
 * Suscripción Desna+ — cotización y activación.
 *
 * GET  /plus/config → colección SFT y red (lo que el GATE de la app necesita)
 * GET  /plus/quote  → importe a pagar (KLV/USDT) + config + validez
 * POST /plus/claim  → verifica el pago y mintea el SFT de Desna+
 */

const express = require('express')
const router  = express.Router()
const { Account, TransactionType } = require('@klever/sdk-node')
const { getKlvUsd } = require('../priceService')
const { pool } = require('../db')

// ─── Config (env) ──────────────────────────────────────────────────────────
const TREASURY_ADDRESS   = process.env.PLUS_TREASURY_ADDRESS ?? ''
const USDT_ASSET_ID      = process.env.PLUS_USDT_ASSET_ID    ?? 'USDT-XXXX'
const PRICE_USD          = Number(process.env.PLUS_PRICE_USD  ?? 5)   // KLV: 5$
const PRICE_USDT         = Number(process.env.PLUS_PRICE_USDT ?? 6)   // USDT: 6$ (recargo a propósito)
const QUOTE_TTL          = Number(process.env.PLUS_QUOTE_TTL  ?? 600) // validez en segundos
const PLUS_COLLECTION    = process.env.PLUS_COLLECTION ?? ''          // ticker real, p.ej. PEPITO-XXXX
const ISSUER_PRIVATE_KEY = process.env.PLUS_ISSUER_PRIVATE_KEY ?? ''  // clave del emisor, 64 hex

// Red de este backend. Informativo para la app (avisa por consola en __DEV__
// si no coincide con la suya — explica un premium fantasma cuando el backend
// está en testnet y el build en mainnet).
const PLUS_NETWORK = process.env.KLEVER_NETWORK ?? 'testnet'

// ⚠️ La app define KLEVER_API **con** sufijo /v1.0 y aquí se añade a mano. Si
// Railway tuviera una KLEVER_API global en formato app, la URL quedaría
// .../v1.0/v1.0/transaction/... y TODAS las verificaciones darían "transacción
// no encontrada" para pagos perfectamente válidos. Se normaliza por si acaso.
const KLEVER_API_BASE = (process.env.KLEVER_API ?? 'https://api.mainnet.klever.org')
  .replace(/\/+$/, '')
  .replace(/\/v1\.0$/, '')

// Precisión por asset. KLV son 6; la del USDT de Klever hay que confirmarla en
// testnet: si no fuesen 6, el importe se leería mal por un factor de 100 o más.
const ASSET_DECIMALS = {
  KLV: 6,
  [USDT_ASSET_ID]: Number(process.env.PLUS_USDT_DECIMALS ?? 6),
}

// Tolerancia sobre el importe esperado. Entre el quote y la confirmación del
// pago pueden pasar minutos: con solo un 5%, una caída normal de KLV convierte
// un pago correcto en "insuficiente". Perder un 10% en el caso extremo sale
// más barato que rechazar pagos legítimos.
const PRICE_TOLERANCE = Number(process.env.PLUS_PRICE_TOLERANCE ?? 0.90)

// ─── Comisiones de red ──────────────────────────────────────────────────────
// Las sirve este backend para que NINGÚN dispositivo tenga que consultarlas.
// Viajan en /plus/config, que la app ya pide al arrancar, así que no supone
// ni una sola petición extra desde el móvil.
//
// El valor es global (lo fija una votación de KFI holders), así que cachearlo
// aquí una hora significa una consulta a Klever por hora EN TOTAL, en vez de
// una por usuario. Y cuando cambia, se propaga a todo el mundo en su siguiente
// arranque — sin esperar a que cada usuario haga una transacción para
// enterarse por su cuenta.
const FEES_CACHE_TTL_MS = Number(process.env.PLUS_FEES_TTL_MS ?? 60 * 60 * 1000)

// Las comisiones se leen de la MISMA red en la que opera el backend.
//
// Antes se forzaban a mainnet, con el argumento de que «las comisiones
// relevantes son las de mainnet». Era un error: si la app opera en testnet, las
// comisiones relevantes son las de testnet, que es donde el usuario paga. Y son
// MUY distintas —KAppFeeTransfer vale 1.000.000 en mainnet y 1 en testnet,
// FeePerDataByte 8.000 frente a 1—, así que la app mostraba 3,056 KLV cuando la
// red cobraba 0,000258. Un factor de 11.845.
//
// Ambas redes exponen /v1.0/network/network-parameters; el fallo original era
// que se consultaba /network/config, que no existe en ninguna de las dos.
const FEES_API = (process.env.PLUS_FEES_API
  ?? process.env.KLEVER_API
  ?? (PLUS_NETWORK === 'mainnet'
        ? 'https://api.mainnet.klever.org'
        : 'https://api.testnet.klever.org'))
  .replace(/\/+$/, '')
  .replace(/\/v1\.0$/, '')

// Respaldo por red, verificado contra transferencias reales:
//   mainnet — kAppFee 1.000000 + bandwidth (250+13)×8000 = 3.104000 KLV
//   testnet — kAppFee 0.000001 + bandwidth (250+7)×1    = 0.000258 KLV
const FEES_FALLBACK_TESTNET = {
  feePerDataByte: 1,
  baseTxSize:     250,
  kApp: { Transfer: 1, AssetTrigger: 2000000, Freeze: 1000000, Unfreeze: 1000000,
          Delegate: 1000000, Undelegate: 1000000, Withdraw: 1000000, Claim: 1000000,
          Vote: 1000000, CreateAsset: 20000000000 },
}

const FEES_FALLBACK_MAINNET = {
  feePerDataByte: 8000,
  baseTxSize:     250,
  kApp: {
    Transfer:     1000000,
    AssetTrigger: 2000000,
    Freeze:       1000000,
    Unfreeze:     1000000,
    Delegate:     1000000,
    Undelegate:   1000000,
    Withdraw:     1000000,
    Claim:        1000000,
    Vote:         1000000,
    CreateAsset:  20000000000,
  },
}

const FEES_FALLBACK = PLUS_NETWORK === 'mainnet'
  ? FEES_FALLBACK_MAINNET
  : FEES_FALLBACK_TESTNET

let _feesCache = null   // { value, ts }

/** Lee un Int64 del formato { type, value } de la API de Klever. */
function readParam(params, key, fallback) {
  const raw = params?.[key]?.value
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * Comisiones actuales de Klever, cacheadas.
 * Nunca lanza: ante cualquier fallo devuelve lo último conocido, y si no hay
 * nada, el respaldo. Una comisión algo desfasada es mucho mejor que romper
 * /plus/config, que además sirve la colección del gate.
 */
async function getNetworkFees() {
  const now = Date.now()
  if (_feesCache && now - _feesCache.ts < FEES_CACHE_TTL_MS) {
    return _feesCache.value
  }

  try {
    const res  = await fetch(`${FEES_API}/v1.0/network/network-parameters`)
    if (!res.ok) throw new Error(`HTTP ${res.status} en ${FEES_API}/v1.0/network/network-parameters`)

    // Ante una URL inexistente la API devuelve HTML, no JSON. Se comprueba
    // antes de parsear para que el log diga qué pasó de verdad en lugar de un
    // "Unexpected token" sin contexto.
    const body = await res.text()
    if (!body.trim().startsWith('{')) {
      throw new Error(`respuesta no JSON de ${FEES_API} (¿red sin este endpoint?)`)
    }

    const json = JSON.parse(body)
    const p    = json?.data?.parameters
    if (!p) throw new Error('network/config sin parámetros')

    const kApp = {}
    for (const name of Object.keys(FEES_FALLBACK.kApp)) {
      kApp[name] = readParam(p, `KAppFee${name}`, FEES_FALLBACK.kApp[name])
    }

    const value = {
      feePerDataByte: readParam(p, 'FeePerDataByte', FEES_FALLBACK.feePerDataByte),
      // No es un parámetro de gobernanza (no se vota): constante de protocolo.
      baseTxSize:     FEES_FALLBACK.baseTxSize,
      kApp,
      updatedAt:      Math.floor(now / 1000),
    }

    _feesCache = { value, ts: now }
    return value
  } catch (e) {
    console.error('[plus] No se pudieron leer las comisiones de red:', e.message)
    if (_feesCache) return _feesCache.value
    return { ...FEES_FALLBACK, updatedAt: null }
  }
}

// Validez del SFT: 1 año en segundos
const SUBSCRIPTION_DURATION_S = 365 * 24 * 60 * 60

// ─── GET /plus/config ──────────────────────────────────────────────────────
// Config que la app necesita para el GATE (qué colección mirar), no para
// comprar. Va aparte de /quote a propósito: quote depende de CoinGecko y
// responde 503 si no hay precio. El gate se consulta en CADA arranque de la
// app, así que colgarlo de un endpoint que puede caer dejaría sin premium a
// todos los suscriptores cada vez que falle el proveedor de precios.
// Sin dependencias externas: esta ruta no puede fallar.
router.get('/config', async (req, res) => {
  res.json({
    collection: PLUS_COLLECTION,
    network:    PLUS_NETWORK,
    // Comisiones de red, para que la app no tenga que consultarlas por su
    // cuenta. getNetworkFees() nunca lanza, así que esta ruta sigue sin poder
    // fallar — importante, porque también sirve la colección del gate.
    fees:       await getNetworkFees(),
  })
})

// ─── GET /plus/quote ───────────────────────────────────────────────────────
// Importe exacto a pagar + config. Sin estado: /plus/claim recalculará el
// esperado con el precio del momento del pago y aceptará una tolerancia.
router.get('/quote', async (req, res) => {
  try {
    const klvUsd = await getKlvUsd()
    if (!(klvUsd > 0)) throw new Error('precio KLV no disponible')

    // 5$ ÷ precio, redondeo arriba para no cobrar de menos. KLV en unidades humanas.
    const klvAmount = Math.ceil(PRICE_USD / klvUsd)

    res.json({
      klvAmount,
      usdtAmount: PRICE_USDT,
      klvAsset:   'KLV',
      usdtAsset:  USDT_ASSET_ID,
      treasury:   TREASURY_ADDRESS,
      validUntil: Math.floor(Date.now() / 1000) + QUOTE_TTL,
    })
  } catch (e) {
    console.error('[plus] Error cotizando:', e.message)
    res.status(503).json({ error: 'No se pudo obtener el precio ahora mismo' })
  }
})

// ─── Helpers de /claim ──────────────────────────────────────────────────────

/** Convierte unidades enteras de cadena a importe humano según el asset. */
function toHuman(rawAmount, assetId) {
  const decimals = ASSET_DECIMALS[assetId] ?? 6
  return Number(rawAmount ?? 0) / Math.pow(10, decimals)
}

/**
 * Verifica una transacción de pago en Klever.
 * Mismo patrón que verifyPayment() en bot.js, adaptado: aquí no hay memo,
 * identificamos el pago por remitente + destinatario + asset + importe.
 */
async function verifyPlusPayment(txHash, expectedWallet) {
  if (!TREASURY_ADDRESS) {
    return { valid: false, reason: 'La tesorería de Desna+ no está configurada.' }
  }

  const res  = await fetch(`${KLEVER_API_BASE}/v1.0/transaction/${txHash}`)
  const json = await res.json()

  if (json.error || !json.data?.transaction) {
    return { valid: false, reason: 'Transacción no encontrada en la red Klever.' }
  }

  const tx = json.data.transaction

  if (tx.status !== 'success') {
    return { valid: false, reason: `La transacción no está confirmada (status: ${tx.status}).` }
  }

  // El remitente de la tx debe coincidir con la wallet que reclama el SFT —
  // evita que alguien reclame con el pago de otra persona.
  if (tx.sender !== expectedWallet) {
    return { valid: false, reason: 'El remitente de la transacción no coincide con la wallet que reclama.' }
  }

  const contracts = Array.isArray(tx.contract) ? tx.contract : []
  let klvAmount  = 0
  let usdtAmount = 0

  for (const c of contracts) {
    const param = c.parameter ?? {}
    const to    = param.toAddress ?? param.receiver ?? ''
    const asset = param.assetId ?? 'KLV'

    if (to !== TREASURY_ADDRESS) continue

    // La precisión depende del asset: dividir todo entre 1e6 leía mal el
    // importe de cualquier token que no tuviera exactamente 6 decimales.
    if (asset === 'KLV')              klvAmount  += toHuman(param.amount, 'KLV')
    else if (asset === USDT_ASSET_ID) usdtAmount += toHuman(param.amount, USDT_ASSET_ID)
  }

  if (klvAmount === 0 && usdtAmount === 0) {
    return { valid: false, reason: 'No se encontró un pago válido a la tesorería de Desna+.' }
  }

  if (usdtAmount > 0) {
    const minUsdt = PRICE_USDT * PRICE_TOLERANCE
    if (usdtAmount < minUsdt) {
      return { valid: false, reason: `Importe USDT insuficiente. Recibido: ${usdtAmount}, mínimo: ${minUsdt}.` }
    }
    return { valid: true, asset: USDT_ASSET_ID, amount: usdtAmount }
  }

  const klvUsd = await getKlvUsd()
  if (!(klvUsd > 0)) {
    // Sin precio no se puede validar el importe. Se rechaza como TRANSITORIO,
    // sin marcar nada como fallido: el usuario reintenta y funciona.
    return { valid: false, retryable: true, reason: 'No se puede validar el importe ahora mismo. Reinténtalo en unos minutos.' }
  }

  const minKlv = (PRICE_USD / klvUsd) * PRICE_TOLERANCE
  if (klvAmount < minKlv) {
    return { valid: false, reason: `Importe KLV insuficiente. Recibido: ${klvAmount.toFixed(2)}, mínimo: ${minKlv.toFixed(2)}.` }
  }

  return { valid: true, asset: 'KLV', amount: klvAmount }
}

/**
 * Mintea un nonce del SFT Desna+ hacia la wallet del pagador, con la
 * metadata soulbound { v, exp, t, w }. Firma con la clave del emisor
 * (la misma wallet con rol canMint sobre PLUS_COLLECTION).
 */
async function mintPlusSft(receiverWallet) {
  const expiresAt = Math.floor(Date.now() / 1000) + SUBSCRIPTION_DURATION_S

  const metadata = JSON.stringify({
    v:   1,
    exp: expiresAt,
    t:   1,
    w:   receiverWallet,
  })

  const account = new Account(ISSUER_PRIVATE_KEY)
  await account.ready

  const payload = {
    triggerType: 0, // Mint
    assetId:     PLUS_COLLECTION,
    receiver:    receiverWallet,
    amount:      1,
    // ⚠️ VERIFICAR EN TESTNET: en las pruebas manuales del mint la metadata
    // iba como uris:[{ key:'metadata', value: json }] (array de pares), no
    // como objeto. Si el SFT se mintea SIN metadata, es esto — y el gate de
    // la app lo ignoraría por no poder leer { v, exp, t, w }.
    uris: {
      metadata,
    },
  }

  const unsignedTx = await account.buildTransaction([
    { payload, type: TransactionType.AssetTrigger },
  ])
  const signedTx = await account.signTransaction(unsignedTx)
  const broadcastRes = await account.broadcastTransactions([signedTx])

  const txHash = broadcastRes?.data?.txsHashes?.[0]
  if (!txHash) {
    throw new Error('El mint no devolvió un hash de transacción — revisar broadcastRes')
  }

  return { txHash, expiresAt }
}

// ─── POST /plus/claim ───────────────────────────────────────────────────────
// Body esperado: { wallet: string, payHash: string }
router.post('/claim', async (req, res) => {
  const { wallet, payHash } = req.body ?? {}

  if (!wallet || !payHash) {
    return res.status(400).json({ error: 'Faltan wallet o payHash en la petición' })
  }

  if (!ISSUER_PRIVATE_KEY || !PLUS_COLLECTION) {
    console.error('[plus] Falta PLUS_ISSUER_PRIVATE_KEY o PLUS_COLLECTION en el entorno')
    return res.status(503).json({ error: 'Desna+ no está disponible ahora mismo' })
  }

  const client = await pool.connect()

  // Fuera del try para que el catch sepa si se llegó a mintear.
  let mintResult = null

  try {
    // ── Idempotencia ────────────────────────────────────────────────────
    // Solo un claim ACTIVO corta el flujo. Antes cortaba con CUALQUIER fila:
    // si el mint fallaba a medias y quedaba 'pending' o 'failed', el usuario
    // recibía ese estado para siempre y no podía reintentar — había pagado y
    // se quedaba sin suscripción, sin salida automática.
    const existing = await client.query(
      'SELECT * FROM plus_subscriptions WHERE pay_hash = $1',
      [payHash],
    )

    if (existing.rows.length > 0 && existing.rows[0].status === 'active') {
      const row = existing.rows[0]
      return res.json({
        status:    row.status,
        nonce:     row.nonce,
        expiresAt: row.expires_at,
        reused:    true,
      })
    }

    // Verificar el pago en la red antes de mintear nada
    const verification = await verifyPlusPayment(payHash, wallet)
    if (!verification.valid) {
      // 503 en los fallos transitorios (p. ej. sin precio disponible): así el
      // cliente sabe que puede reintentar, en vez de leerlo como pago inválido.
      const code = verification.retryable ? 503 : 402
      return res.status(code).json({ error: verification.reason })
    }

    // ── Registrar el intento ────────────────────────────────────────────
    // ON CONFLICT hace el upsert atómico: dos peticiones simultáneas con el
    // mismo payHash ya no chocan contra el UNIQUE ni se pisan la fila entre
    // ellas (el SELECT de arriba y este INSERT no eran atómicos juntos).
    await client.query(
      `INSERT INTO plus_subscriptions (wallet_address, pay_hash, asset, amount_paid, status)
       VALUES ($1, $2, $3, $4, 'pending')
       ON CONFLICT (pay_hash) DO UPDATE
         SET status = 'pending', updated_at = NOW()`,
      [wallet, payHash, verification.asset, String(verification.amount)],
    )

    mintResult = await mintPlusSft(wallet)
    const { txHash, expiresAt } = mintResult

    // TODO: extraer el nonce real del resultado del broadcast/de la tx una
    // vez confirmada — de momento se deja NULL y se puede rellenar con un
    // proceso posterior que consulte /assets/{PLUS_COLLECTION}/nfts.
    await client.query(
      `UPDATE plus_subscriptions
       SET status = 'active', expires_at = to_timestamp($1), updated_at = NOW()
       WHERE pay_hash = $2`,
      [expiresAt, payHash],
    )

    res.json({
      status: 'active',
      expiresAt,
      mintTxHash: txHash,
      reused: false,
    })
  } catch (e) {
    console.error('[plus] Error en /claim:', e.message)

    if (mintResult) {
      // El SFT SÍ se minteó y falló algo posterior (normalmente el UPDATE).
      // Marcarlo 'failed' sería mentir: el usuario tiene su suscripción en
      // cadena. Se deja el hash del mint para poder repararlo a mano.
      console.error(
        `[plus] ⚠️ MINT OK PERO BD INCONSISTENTE — payHash=${payHash} ` +
        `wallet=${wallet} mintTx=${mintResult.txHash} exp=${mintResult.expiresAt}`,
      )
      await client.query(
        `UPDATE plus_subscriptions
         SET status = 'minted_unconfirmed', updated_at = NOW()
         WHERE pay_hash = $1`,
        [payHash],
      ).catch(() => {})

      // El SFT existe en cadena, así que el gate de la app ya dará premium:
      // responder error haría que el usuario reintentase y pagase dos veces.
      return res.json({
        status:     'active',
        expiresAt:  mintResult.expiresAt,
        mintTxHash: mintResult.txHash,
        reused:     false,
      })
    }

    // El mint no llegó a ejecutarse: 'failed', pero el claim SÍ se puede
    // reintentar con el mismo payHash (la idempotencia ya solo corta en
    // 'active'), así que un fallo transitorio se resuelve solo.
    await client.query(
      `UPDATE plus_subscriptions SET status = 'failed', updated_at = NOW() WHERE pay_hash = $1`,
      [payHash],
    ).catch(() => {})

    res.status(500).json({ error: 'No se pudo procesar la activación de Desna+' })
  } finally {
    client.release()
  }
})

module.exports = router
