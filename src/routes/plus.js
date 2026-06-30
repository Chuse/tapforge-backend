/**
 * routes/plus.js
 * Suscripción Desna+ — cotización y activación.
 *
 * GET  /plus/quote   → importe a pagar (KLV/USDT) + config + validez
 * POST /plus/claim   → (pendiente) verifica el pago y mintea/renueva el SFT
 */

const express = require('express')
const router  = express.Router()
const { getKlvUsd } = require('../priceService')

// ─── Config (env) ──────────────────────────────────────────────────────────
const TREASURY_ADDRESS = process.env.PLUS_TREASURY_ADDRESS ?? ''
const USDT_ASSET_ID    = process.env.PLUS_USDT_ASSET_ID    ?? 'USDT-XXXX'
const PRICE_USD        = Number(process.env.PLUS_PRICE_USD  ?? 5)   // KLV: 5$
const PRICE_USDT       = Number(process.env.PLUS_PRICE_USDT ?? 6)   // USDT: 6$ (recargo a propósito)
const QUOTE_TTL        = Number(process.env.PLUS_QUOTE_TTL  ?? 600) // validez en segundos

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

module.exports = router
