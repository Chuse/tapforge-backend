const express = require('express')
const cors    = require('cors')
const { changellyCall } = require('./changelly')

const app  = express()
const PORT = process.env.PORT ?? 3000

app.use(cors())
app.use(express.json())

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'TapForge Backend' })
})

// ── GET /swap/changelly/currencies ────────────────────────────────────────────
// Lista de monedas disponibles para swap
app.get('/swap/changelly/currencies', async (req, res) => {
  try {
    const result = await changellyCall('getCurrencies')
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── POST /swap/changelly/quote ────────────────────────────────────────────────
// Obtener cotización para un swap
// Body: { from: "KLV", to: "BTC", amount: "100" }
app.post('/swap/changelly/quote', async (req, res) => {
  try {
    const { from, to, amount } = req.body
    if (!from || !to || !amount) {
      return res.status(400).json({ error: 'Faltan parámetros: from, to, amount' })
    }

    // Obtener cotización
    const [exchangeAmount, minAmount] = await Promise.all([
      changellyCall('getExchangeAmount', { from, to, amount }),
      changellyCall('getMinAmount', { from, to }),
    ])

    // Obtener rango
    const range = await changellyCall('getExchangeRange', { from, to }).catch(() => null)

    res.json({
      engine:           'changelly',
      keypairId:        `${from}_${to}`,
      quoteId:          `${from}_${to}_${amount}_${Date.now()}`,
      fromAmount:       amount,
      toAmount:         exchangeAmount,
      toAmountMin:      (parseFloat(exchangeAmount) * 0.995).toFixed(8).toString(),
      rate:             (parseFloat(exchangeAmount) / parseFloat(amount)).toFixed(8).toString(),
      fee:              '0',
      feePercent:       '0.5',
      networkFee:       '0',
      estimatedMinutes: 15,
      expiresAt:        Math.floor(Date.now() / 1000) + 600, // 10 min
      minAmount:        minAmount,
      maxAmount:        range?.maxAmount ?? null,
      slippage:         0,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── POST /swap/changelly/order ────────────────────────────────────────────────
// Crear orden de swap
// Body: { from, to, amount, toAddress, refundAddress? }
app.post('/swap/changelly/order', async (req, res) => {
  try {
    const { from, to, amount, toAddress, refundAddress } = req.body
    if (!from || !to || !amount || !toAddress) {
      return res.status(400).json({ error: 'Faltan parámetros' })
    }

    const result = await changellyCall('createTransaction', {
      from,
      to,
      amount,
      address:       toAddress,
      refundAddress: refundAddress ?? toAddress,
    })

    res.json({
      orderId:        result.id,
      depositAddress: result.payinAddress,
      depositAmount:  result.amountExpectedFrom,
      toAddress:      result.payoutAddress,
      status:         result.status,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── GET /swap/changelly/order/:id ─────────────────────────────────────────────
// Estado de una orden
app.get('/swap/changelly/order/:id', async (req, res) => {
  try {
    const result = await changellyCall('getStatus', { id: req.params.id })
    res.json({ status: result })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── GET /swap/changelly/min-amount ────────────────────────────────────────────
// Mínimo para un par
app.get('/swap/changelly/min-amount', async (req, res) => {
  try {
    const { from, to } = req.query
    if (!from || !to) return res.status(400).json({ error: 'Faltan from y to' })
    const result = await changellyCall('getMinAmount', { from, to })
    res.json({ minAmount: result })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.listen(PORT, () => {
  console.log(`TapForge Backend corriendo en puerto ${PORT}`)
})
