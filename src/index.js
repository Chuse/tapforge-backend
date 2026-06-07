const express     = require('express')
const cors        = require('cors')
const rateLimit   = require('express-rate-limit')

const { initDB }      = require('./db')
const changellyRouter = require('./routes/changelly')
const swapRouter      = require('./routes/swap')
const assetsRouter    = require('./routes/assets')

const app  = express()
const PORT = process.env.PORT ?? 8080

app.use(cors())
app.use(express.json())
app.set('trust proxy', 1) // Railway usa proxy

// ─── Rate limiting global ──────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minuto
  max:      60,           // máx 60 requests por IP por minuto
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Demasiadas peticiones, intenta de nuevo en un minuto' },
})
app.use(globalLimiter)

// ─── Rate limiting estricto para endpoints admin ───────────────────────────
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minuto
  max:      5,            // máx 5 requests por IP por minuto
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Demasiadas peticiones admin, intenta de nuevo en un minuto' },
})

// ─── Health ────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'TapForge Backend' })
})

// ─── Assets ────────────────────────────────────────────────────────────────
// Rate limiting estricto solo en endpoints que modifican datos
app.use('/assets/sync',          adminLimiter)
app.use('/assets/chains/:id',    adminLimiter)
app.use('/assets', assetsRouter)

// ─── Changelly ────────────────────────────────────────────────────────────
app.use('/swap/changelly', changellyRouter)

// ─── Swap ─────────────────────────────────────────────────────────────────
app.use('/swap', swapRouter)

// ─── 404 ──────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint no encontrado' })
})

// ─── Arranque ─────────────────────────────────────────────────────────────
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
