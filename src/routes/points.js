/**
 * routes/points.js
 * Sistema de puntos de TapForge.
 *
 * GET  /points/:address        → puntos totales + desglose
 * POST /points/event           → registrar evento off-chain
 * GET  /points/:address/events → historial de eventos off-chain
 */

const express  = require('express')
const router   = express.Router()
const { pool } = require('../db')

const KLEVER_API = 'https://api.mainnet.klever.org/v1.0'

// ─── Configuración de puntos ──────────────────────────────────────────────

const ONCHAIN_POINTS = {
  transfer_send:    10,   // enviar una tx
  transfer_receive: 5,    // recibir una tx
  freeze:           20,   // hacer stake
  claim:            15,   // reclamar staking
  delegate:         25,   // delegar a validador
  first_tx_bonus:   100,  // bonus primera tx
}

const OFFCHAIN_POINTS = {
  // Una sola vez
  first_contact:    { points: 20,  once: true  },
  create_domain:    { points: 500, once: true  },
  activate_tapcard: { points: 200, once: true  },
  import_wallet:    { points: 50,  once: true  },
  wallet_added:     { points: 0,   once: true  }, // solo marca la fecha, no da puntos
  // Cada vez
  swap:             { points: 50,  once: false },
  open_dapp:        { points: 10,  once: false },
}

// ─── Inicializar tabla user_events ────────────────────────────────────────
async function initPointsDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_events (
      id         SERIAL PRIMARY KEY,
      address    TEXT NOT NULL,
      event      TEXT NOT NULL,
      chain      TEXT DEFAULT 'klever',
      points     INTEGER NOT NULL DEFAULT 0,
      metadata   JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_user_events_address ON user_events(address);
  `)
}
initPointsDB().catch(console.error)

// ─── Niveles ──────────────────────────────────────────────────────────────
const LEVELS = [
  { level: 1, name: 'Explorer',  points: 0       },
  { level: 2, name: 'Builder',   points: 500     },
  { level: 3, name: 'Architect', points: 2000    },
  { level: 4, name: 'Guardian',  points: 7500    },
  { level: 5, name: 'Veteran',   points: 20000   },
  { level: 6, name: 'Master',    points: 50000   },
  { level: 7, name: 'Legend',    points: 150000  },
]

function calcLevel(points) {
  let currentLevel = LEVELS[0]
  let nextLevel    = null
  for (const lvl of LEVELS) {
    if (points >= lvl.points) currentLevel = lvl
    else if (!nextLevel)      nextLevel    = lvl
  }
  return { currentLevel, nextLevel }
}

// ─── Cache en memoria (TTL 2 min) ─────────────────────────────────────────
const ONCHAIN_CACHE_TTL = 2 * 60 * 1000 // 2 minutos
const onchainCache = new Map() // address → { points, breakdown, cachedAt }

function getCached(address) {
  const entry = onchainCache.get(address)
  if (!entry) return null
  if (Date.now() - entry.cachedAt > ONCHAIN_CACHE_TTL) {
    onchainCache.delete(address)
    return null
  }
  return entry
}

function setCached(address, points, breakdown) {
  onchainCache.set(address, { points, breakdown, cachedAt: Date.now() })
}

// ─── Calcular puntos on-chain ─────────────────────────────────────────────
async function calcOnchainPoints(address) {
  const cached = getCached(address)
  if (cached) return cached

  try {
    // Obtener fecha desde la que contar
    // Si tiene wallet_added en BD → desde esa fecha
    // Si no → desde el 1 de junio de 2026 (inicio de TapForge)
    const TAPFORGE_EPOCH = new Date('2026-06-01T00:00:00Z').getTime() / 1000

    const walletEvent = await pool.query(
      'SELECT created_at FROM user_events WHERE address = $1 AND event = $2 ORDER BY created_at ASC LIMIT 1',
      [address, 'wallet_added']
    )
    const sinceSec = walletEvent.rows[0]
      ? new Date(walletEvent.rows[0].created_at).getTime() / 1000
      : TAPFORGE_EPOCH

    // Obtener historial de txs
    const res = await fetch(
      `${KLEVER_API}/address/${address}/transactions?limit=100`
    )
    if (!res.ok) return { points: 0, breakdown: [] }

    const data = await res.json()
    let txs = data?.data?.transactions ?? []

    // Filtrar txs posteriores a la fecha de inicio
    txs = txs.filter(tx => (tx.timestamp ?? 0) >= sinceSec)

    let points    = 0
    const breakdown = []

    if (txs.length > 0) {
      // Bonus primera tx
      points += ONCHAIN_POINTS.first_tx_bonus
      breakdown.push({ event: 'first_tx_bonus', points: ONCHAIN_POINTS.first_tx_bonus, count: 1 })
    }

    // Contadores por tipo
    const counts = {
      transfer_send:    0,
      transfer_receive: 0,
      freeze:           0,
      claim:            0,
      delegate:         0,
    }

    for (const tx of txs) {
      const contracts = tx.contract ?? []
      for (const contract of contracts) {
        const type = contract.typeString ?? ''

        if (type === 'TransferContractType') {
          if (tx.sender === address) counts.transfer_send++
          else counts.transfer_receive++
        } else if (type === 'FreezeContractType') {
          counts.freeze++
        } else if (type === 'ClaimContractType') {
          counts.claim++
        } else if (type === 'DelegateContractType') {
          counts.delegate++
        }
      }
    }

    // Sumar puntos por tipo
    for (const [type, count] of Object.entries(counts)) {
      if (count > 0 && ONCHAIN_POINTS[type]) {
        const p = count * ONCHAIN_POINTS[type]
        points += p
        breakdown.push({ event: type, points: p, count })
      }
    }

    setCached(address, points, breakdown)
    return { points, breakdown }
  } catch (e) {
    console.error('[points] Error calculando on-chain:', e.message)
    return { points: 0, breakdown: [] }
  }
}

// ─── GET /points ──────────────────────────────────────────────────────────
// Soporta una o múltiples direcciones firmantes
// GET /points?addresses=klv1abc...,klv1xyz...
// GET /points/:address (compatibilidad hacia atrás)
router.get('/', async (req, res) => {
  const addressesParam = req.query.addresses ?? ''
  const addresses = addressesParam
    .split(',')
    .map(a => a.trim())
    .filter(a => a.startsWith('klv1') && a.length === 62)

  if (addresses.length === 0) {
    return res.status(400).json({ error: 'Se requiere al menos una dirección válida' })
  }

  try {
    // Calcular puntos de cada dirección en paralelo
    const results = await Promise.all(addresses.map(calcOnchainPoints))

    // Sumar puntos on-chain
    let totalOnchain = 0
    const onchainBreakdown = []
    for (const r of results) {
      totalOnchain += r.points
      onchainBreakdown.push(...r.breakdown)
    }

    // Puntos off-chain — suma de todas las direcciones
    const offchainResult = await pool.query(
      `SELECT event, SUM(points) as total, COUNT(*) as count 
       FROM user_events WHERE address = ANY($1) GROUP BY event`,
      [addresses]
    )

    let offchainPoints = 0
    const offchainBreakdown = []
    for (const row of offchainResult.rows) {
      offchainPoints += parseInt(row.total)
      offchainBreakdown.push({
        event:  row.event,
        points: parseInt(row.total),
        count:  parseInt(row.count),
      })
    }

    const totalPoints = totalOnchain + offchainPoints
    const { currentLevel, nextLevel } = calcLevel(totalPoints)

    res.json({
      addresses,
      points:    totalPoints,
      level:     currentLevel,
      nextLevel,
      breakdown: {
        onchain:  onchainBreakdown,
        offchain: offchainBreakdown,
      },
    })
  } catch (e) {
    console.error('[points] Error:', e.message)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── GET /points/:address ─────────────────────────────────────────────────
// Compatibilidad hacia atrás — una sola dirección
router.get('/:address', async (req, res) => {
  const { address } = req.params
  if (!address.startsWith('klv1') || address.length !== 62) {
    return res.status(400).json({ error: 'Dirección Klever inválida' })
  }
  req.query.addresses = address
  return router.handle({ ...req, url: '/', method: 'GET' }, res, () => {})
})

// ─── POST /points/event ───────────────────────────────────────────────────
// Registrar evento off-chain desde la app
router.post('/event', async (req, res) => {
  const { address, event, chain = 'klever', metadata = {} } = req.body

  // Validar
  if (!address || !event) {
    return res.status(400).json({ error: 'address y event son requeridos' })
  }
  if (!address.startsWith('klv1') || address.length !== 62) {
    return res.status(400).json({ error: 'Dirección Klever inválida' })
  }
  if (!OFFCHAIN_POINTS[event]) {
    return res.status(400).json({ error: `Evento '${event}' no reconocido` })
  }

  const config = OFFCHAIN_POINTS[event]

  try {
    // Si es un evento "una sola vez", verificar que no existe ya
    if (config.once) {
      const existing = await pool.query(
        'SELECT id FROM user_events WHERE address = $1 AND event = $2',
        [address, event]
      )
      if (existing.rows.length > 0) {
        return res.json({
          success: false,
          message: 'Este evento ya fue registrado anteriormente',
          points:  0,
        })
      }
    }

    // Insertar evento
    await pool.query(
      'INSERT INTO user_events (address, event, chain, points, metadata) VALUES ($1, $2, $3, $4, $5)',
      [address, event, chain, config.points, JSON.stringify(metadata)]
    )

    // Invalidar cache on-chain de esta dirección
    onchainCache.delete(address)

    res.json({
      success: true,
      event,
      points:  config.points,
      message: `+${config.points} puntos por ${event}`,
    })
  } catch (e) {
    console.error('[points] Error registrando evento:', e.message)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── GET /points/:address/events ──────────────────────────────────────────
router.get('/:address/events', async (req, res) => {
  const { address } = req.params
  try {
    const result = await pool.query(
      'SELECT event, chain, points, metadata, created_at FROM user_events WHERE address = $1 ORDER BY created_at DESC LIMIT 50',
      [address]
    )
    res.json({ events: result.rows })
  } catch (e) {
    res.status(500).json({ error: 'Error interno' })
  }
})

module.exports = router
