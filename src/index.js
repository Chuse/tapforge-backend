const express = require('express')
const cors    = require('cors')

const { initDB }      = require('./db')
const changellyRouter = require('./routes/changelly')
const swapRouter      = require('./routes/swap')
const assetsRouter    = require('./routes/assets')

const app  = express()
const PORT = process.env.PORT ?? 8080

app.use(cors())
app.use(express.json())

// ─── Health ────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'TapForge Backend' })
})

// ─── Assets ────────────────────────────────────────────────────────────────
app.use('/assets', assetsRouter)

// ─── Changelly ────────────────────────────────────────────────────────────
app.use('/swap/changelly', changellyRouter)

// ─── Swap ─────────────────────────────────────────────────────────────────
app.use('/swap', swapRouter)

// ─── 404 ──────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint no encontrado' })
})

// ─── Arranque con init de BD ───────────────────────────────────────────────
initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`TapForge Backend corriendo en puerto ${PORT}`)
    })
  })
  .catch(err => {
    console.error('Error iniciando la base de datos:', err)
    process.exit(1)
  })
