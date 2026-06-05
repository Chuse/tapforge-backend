const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const CHANGELLY_API = 'https://api.changelly.com/v2';
const CHANGELLY_PUBLIC_KEY = process.env.CHANGELLY_PUBLIC_KEY || '';
const CHANGELLY_PRIVATE_KEY = process.env.CHANGELLY_PRIVATE_KEY || '';

/**
 * Firma una petición a Changelly con RSA-SHA256
 */
function signRequest(body) {
  const message = JSON.stringify(body);
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(message);
  sign.end();
  return sign.sign(CHANGELLY_PRIVATE_KEY, 'base64');
}

async function changellyRequest(method, params = {}) {
  const body = {
    jsonrpc: '2.0',
    id: Date.now().toString(),
    method,
    params,
  };

  const signature = signRequest(body);

  const response = await fetch(CHANGELLY_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': CHANGELLY_PUBLIC_KEY,
      'X-Api-Signature': signature,
    },
    body: JSON.stringify(body),
  });

  return response.json();
}

// GET /swap/changelly/currencies
router.get('/currencies', async (req, res) => {
  try {
    const data = await changellyRequest('getCurrencies');
    res.json(data.result || data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /swap/changelly/min-amount?from=klv&to=usdt
router.get('/min-amount', async (req, res) => {
  const { from, to } = req.query;
  try {
    const data = await changellyRequest('getMinAmount', { from, to });
    res.json(data.result || data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /swap/changelly/quote
router.post('/quote', async (req, res) => {
  const { from, to, amount } = req.body;
  try {
    const data = await changellyRequest('getExchangeAmount', { from, to, amount });
    res.json(data.result || data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /swap/changelly/order
router.post('/order', async (req, res) => {
  const { from, to, amount, address, extraId } = req.body;
  try {
    const data = await changellyRequest('createTransaction', {
      from, to, amount, address, extraId,
    });
    res.json(data.result || data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /swap/changelly/order/:id
router.get('/order/:id', async (req, res) => {
  try {
    const data = await changellyRequest('getTransactions', { id: req.params.id });
    res.json(data.result || data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
