/**
 * validatorsRoute.js
 * Router del endpoint de cambios de validadores para el semáforo de salud de Desna.
 *
 * Montar en tu server (donde tengas `app` y el `pool` de pg):
 *
 *   const validatorsRoute = require('./validatorsRoute')
 *   app.use(validatorsRoute(pool))
 *
 * Expone:  GET /validators/changes  →  { epoch, changes: [...] }
 */

const express = require('express')
const { getLatestValidatorChanges } = require('./epochService')

module.exports = function validatorsRoute(pool) {
  const router = express.Router()

  router.get('/validators/changes', async (req, res) => {
    try {
      const data = await getLatestValidatorChanges(pool)
      res.json(data)
    } catch (e) {
      console.error('[validators/changes]', e.message)
      res.status(500).json({ error: 'internal' })
    }
  })

  return router
}
