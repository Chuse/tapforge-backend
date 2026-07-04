/**
 * routes/validators.js
 * Endpoint de cambios de validadores para el semáforo de salud de Desna.
 *
 * Montado en index.js:
 *   const validatorsRouter = require('./routes/validators')
 *   app.use('/validators', validatorsRouter)
 *
 * Expone:  GET /validators/changes  →  { epoch, changes: [...] }
 */

const express = require('express')
const { pool } = require('../db')
const { getLatestValidatorChanges } = require('../epochService')

const router = express.Router()

router.get('/changes', async (req, res) => {
  try {
    const data = await getLatestValidatorChanges(pool)
    res.json(data)
  } catch (e) {
    console.error('[validators/changes]', e.message)
    res.status(500).json({ error: 'internal' })
  }
})

module.exports = router
