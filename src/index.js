const express     = require('express')
const cors        = require('cors')
const rateLimit   = require('express-rate-limit')

const { initDB, pool }  = require('./db')
const changellyRouter   = require('./routes/changelly')
const swapRouter        = require('./routes/swap')
const assetsRouter      = require('./routes/assets')
const adminAuthRouter   = require('./routes/adminAuth')
const pointsRouter      = require('./routes/points')
const adminChainsRouter = require('./routes/adminChains')
const { createBot, startEpochCron } = require('./bot')

const app  = express()
const PORT = process.env.PORT ?? 8080

app.use(cors())
app.use(express.json())
app.set('trust proxy', 1)

// ─── Rate limiting global ──────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      60,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Demasiadas peticiones, intenta de nuevo en un minuto' },
})
app.use(globalLimiter)

// ─── Rate limiting estricto para endpoints admin ───────────────────────────
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      5,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Demasiadas peticiones admin, intenta de nuevo en un minuto' },
})

// ─── Health ────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'TapForge Backend' })
})

// ─── Admin auth ────────────────────────────────────────────────────────────
app.use('/admin/auth', adminAuthRouter)
app.use('/admin/chains', adminChainsRouter)

// ─── Assets ────────────────────────────────────────────────────────────────
app.use('/assets/sync',       adminLimiter)
app.use('/assets/chains/:id', adminLimiter)
app.use('/assets', assetsRouter)

// ─── Points ────────────────────────────────────────────────────────────────
app.use('/points', pointsRouter)

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

    const bot = createBot(pool)
    startEpochCron(pool, bot)

    bot.launch().then(() => {
      console.log('[bot] Desna bot iniciado en modo polling')
    })

    process.once('SIGINT',  () => bot.stop('SIGINT'))
    process.once('SIGTERM', () => bot.stop('SIGTERM'))
  })
  .catch(err => {
    console.error('Error iniciando la base de datos:', err)
    process.exit(1)
  })
