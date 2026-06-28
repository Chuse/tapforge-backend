const express     = require('express')
const cors        = require('cors')
const rateLimit   = require('express-rate-limit')
const path        = require('path')

const { initDB, pool }  = require('./db')

const changellyRouter   = require('./routes/changelly')
const swapRouter        = require('./routes/swap')
const assetsRouter      = require('./routes/assets')
const pointsRouter      = require('./routes/points')
const validatorsRouter  = require('./routes/validators')

const adminAuthRouter   = require('./routes/adminAuth')
const adminChainsRouter = require('./routes/adminChains')
const telegramRouter    = require('./routes/telegram')

const { createBot, startEpochCron } = require('./bot')

const app  = express()
const PORT = process.env.PORT ?? 8080

// CORS
// Los endpoints de la app móvil no son peticiones de navegador, así que el
// origin no les afecta. Restringir aquí cierra el panel admin web (que vive en
// este mismo backend) a orígenes conocidos. Configurable por env en Railway:
//   ADMIN_ORIGIN = https://tu-panel-admin
// Si no hay orígenes configurados, no se pasa whitelist (comportamiento abierto)
// para no romper en un despliegue sin configurar — endurece poniendo ADMIN_ORIGIN.
const allowedOrigins = [
  process.env.ADMIN_ORIGIN,
  'https://desna.io',
  'https://www.desna.io',
].filter(Boolean)

app.use(cors({
  origin: (origin, callback) => {
    // Permitir peticiones sin origin (apps móviles, curl, health checks)
    if (!origin) return callback(null, true)
    if (allowedOrigins.length === 0) return callback(null, true)
    if (allowedOrigins.includes(origin)) return callback(null, true)
    return callback(new Error('Origen no permitido por CORS'))
  },
  credentials: true,
}))
app.use(express.json())
app.set('trust proxy', 1)

// ─────────────────────────────────────────────────────────────
// Rate limiting global
// ─────────────────────────────────────────────────────────────

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Demasiadas peticiones, intenta de nuevo en un minuto',
  },
})

app.use(globalLimiter)

// ─────────────────────────────────────────────────────────────
// Rate limiting admin
// ─────────────────────────────────────────────────────────────

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Demasiadas peticiones admin, intenta de nuevo en un minuto',
  },
})

// ─────────────────────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'TapForge Backend',
  })
})

// ─────────────────────────────────────────────────────────────
// Admin API
// ─────────────────────────────────────────────────────────────

app.use('/admin/auth', adminAuthRouter)
app.use('/admin/chains', adminChainsRouter)

// ─────────────────────────────────────────────────────────────
// Admin Web
// ─────────────────────────────────────────────────────────────

app.use(
  '/admin',
  express.static(path.join(__dirname, 'public', 'admin'))
)

// ─────────────────────────────────────────────────────────────
// Assets
// ─────────────────────────────────────────────────────────────

app.use('/assets/sync', adminLimiter)
app.use('/assets/chains/:id', adminLimiter)
app.use('/assets', assetsRouter)

// ─────────────────────────────────────────────────────────────
// Points
// ─────────────────────────────────────────────────────────────

app.use('/points', pointsRouter)

// ─────────────────────────────────────────────────────────────
// Validators (semáforo de salud)
// ─────────────────────────────────────────────────────────────

app.use('/validators', validatorsRouter)

// ─────────────────────────────────────────────────────────────
// Changelly
// ─────────────────────────────────────────────────────────────

app.use('/swap/changelly', changellyRouter)

// ─────────────────────────────────────────────────────────────
// Swap
// ─────────────────────────────────────────────────────────────

app.use('/swap', swapRouter)

// ─────────────────────────────────────────────────────────────
// Telegram notifications
// ─────────────────────────────────────────────────────────────

app.use('/api/telegram', telegramRouter)

// ─────────────────────────────────────────────────────────────
// 404
// ─────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint no encontrado',
  })
})

// ─────────────────────────────────────────────────────────────
// Arranque
// ─────────────────────────────────────────────────────────────

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

    process.once('SIGINT', () => bot.stop('SIGINT'))
    process.once('SIGTERM', () => bot.stop('SIGTERM'))
  })
  .catch(err => {
    console.error('Error iniciando la base de datos:', err)
    process.exit(1)
  })
