const express = require('express');
const router = express.Router();
const {
  SWAP_PAIRS,
  REFERRAL_ADDRESS,
  REFERRAL_PERCENTAGE,
  BITCOIN_ME_REFERRAL_CONTRACT,
} = require('../config/swapProviders');

const BITCOIN_ME_API = 'https://api.bitcoin.me';

/**
 * GET /swap/providers
 * Devuelve los pares disponibles y sus metadatos.
 * La app móvil usa esto para construir el selector de swap.
 */
router.get('/providers', (req, res) => {
  const pairs = SWAP_PAIRS
    .filter(p => p.enabled)
    .map(({ from, fromAssetId, to, toAssetId, provider, poolAddress, liquidityUsd }) => ({
      from,
      fromAssetId: fromAssetId || from,
      to,
      toAssetId: toAssetId || to,
      provider,
      poolAddress,
      liquidityUsd,
    }));

  res.json({
    pairs,
    referral: {
      address: REFERRAL_ADDRESS,
      percentage: REFERRAL_PERCENTAGE,
      contract: BITCOIN_ME_REFERRAL_CONTRACT,
    },
  });
});

/**
 * POST /swap/quote
 * Obtiene cotización del proveedor correspondiente al par.
 *
 * Body: { from: "KLV", to: "USDT", amountIn: "1000" }
 * Response: { amountOut, priceImpact, provider, referralFee, minAmountOut }
 */
router.post('/quote', async (req, res) => {
  const { from, to, amountIn } = req.body;

  if (!from || !to || !amountIn) {
    return res.status(400).json({ error: 'Faltan parámetros: from, to, amountIn' });
  }

  const pair = SWAP_PAIRS.find(
    p => p.enabled && p.from === from.toUpperCase() && p.to === to.toUpperCase()
  );

  if (!pair) {
    return res.status(404).json({ error: `Par ${from}→${to} no disponible` });
  }

  try {
    if (pair.provider === 'bitcoin.me') {
      const response = await fetch(`${BITCOIN_ME_API}/quotation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amountIn: String(amountIn),
          tokenIn: pair.fromAssetId || from,
          tokenOut: pair.toAssetId || to,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        return res.status(502).json({ error: 'Error en Bitcoin.me', detail: err });
      }

      const data = await response.json();

      // Calcular referral fee (se descuenta del output, no del input)
      const amountOut = parseFloat(data.amountOut || data.amount_out || '0');
      const referralFee = amountOut * (REFERRAL_PERCENTAGE / 100000);
      const userReceives = amountOut - referralFee;

      // Slippage mínimo recomendado: 1%
      const slippageTolerance = 0.01;
      const minAmountOut = userReceives * (1 - slippageTolerance);

      return res.json({
        provider: 'bitcoin.me',
        from: pair.from,
        to: pair.to,
        amountIn: String(amountIn),
        amountOut: amountOut.toString(),
        userReceives: userReceives.toFixed(6),
        referralFee: referralFee.toFixed(6),
        referralPercentage: `${REFERRAL_PERCENTAGE / 1000}%`,
        minAmountOut: Math.floor(minAmountOut).toString(),
        poolAddress: pair.poolAddress,
        referralContract: BITCOIN_ME_REFERRAL_CONTRACT,
        referralAddress: REFERRAL_ADDRESS,
        rawQuote: data,
      });
    }

    // Aquí se añadirían otros proveedores en el futuro (changelly, etc.)
    return res.status(501).json({ error: `Proveedor ${pair.provider} no implementado aún` });

  } catch (err) {
    console.error('[swap/quote] Error:', err.message);
    return res.status(500).json({ error: 'Error interno al obtener cotización' });
  }
});

/**
 * GET /swap/pairs
 * Alias simplificado — devuelve solo los pares from/to disponibles.
 * Útil para validar en la app antes de llamar a /quote.
 */
router.get('/pairs', (req, res) => {
  const pairs = SWAP_PAIRS
    .filter(p => p.enabled)
    .map(p => ({ from: p.from, to: p.to, provider: p.provider }));
  res.json(pairs);
});

module.exports = router;
