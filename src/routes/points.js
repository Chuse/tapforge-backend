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

// ─── Calcular puntos on-chain ─────────────────────────────────────────────
async function calcOnchainPoints(address) {
  try {
    // Obtener historial completo de txs (hasta 100)
    const res = await fetch(
      `${KLEVER_API}/address/${address}/transactions?limit=100`
    )
    if (!res.ok) return { points: 0, breakdown: [] }

    const data = await res.json()
    const txs  = data?.data?.transactions ?? []

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

    return { points, breakdown }
  } catch (e) {
    console.error('[points] Error calculando on-chain:', e.message)
    return { points: 0, breakdown: [] }
  }
}

// ─── GET /points/:address ─────────────────────────────────────────────────
router.get('/:address', async (req, res) => {
  const { address } = req.params

  if (!address.startsWith('klv1') || address.length !== 62) {
    return res.status(400).json({ error: 'Dirección Klever inválida' })
  }

  try {
    // Puntos on-chain
    const onchain = await calcOnchainPoints(address)

    // Puntos off-chain desde BD
    const offchainResult = await pool.query(
      'SELECT event, SUM(points) as total, COUNT(*) as count FROM user_events WHERE address = $1 GROUP BY event',
      [address]
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

    const totalPoints = onchain.points + offchainPoints

    // Calcular nivel
    const LEVELS = [
      { level: 1, name: 'Explorer',  points: 0       },
      { level: 2, name: 'Builder',   points: 500     },
      { level: 3, name: 'Architect', points: 2000    },
      { level: 4, name: 'Guardian',  points: 7500    },
      { level: 5, name: 'Veteran',   points: 20000   },
      { level: 6, name: 'Master',    points: 50000   },
      { level: 7, name: 'Legend',    points: 150000  },
    ]

    let currentLevel = LEVELS[0]
    let nextLevel    = null
    for (let i = 0; i < LEVELS.length; i++) {
      if (totalPoints >= LEVELS[i].points) currentLevel = LEVELS[i]
      if (totalPoints < LEVELS[i].points && !nextLevel) nextLevel = LEVELS[i]
    }

    res.json({
      address,
      points: totalPoints,
      level:  currentLevel,
      nextLevel,
      breakdown: {
        onchain:  onchain.breakdown,
        offchain: offchainBreakdown,
      },
    })
  } catch (e) {
    console.error('[points] Error:', e.message)
    res.status(500).json({ error: 'Error interno' })
  }
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
