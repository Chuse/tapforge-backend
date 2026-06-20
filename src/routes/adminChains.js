const express = require('express')
const { pool } = require('../db')
const { requireViewer, requireAdmin } = require('../middleware/adminAuth')

const router = express.Router()

const ID_REGEX = /^[a-z0-9_-]{2,50}$/

function cleanString(value, max = 255) {
  if (value === undefined || value === null) return null
  const v = String(value).trim()
  if (!v) return null
  return v.slice(0, max)
}

function cleanUrl(value) {
  const v = cleanString(value, 500)
  if (!v) return null
  if (!/^https?:\/\//i.test(v)) return null
  return v
}

function toInt(value, fallback = 99) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

async function writeAudit(client, req, action, entityId, before, after) {
  await client.query(
    `
    INSERT INTO admin_audit_log
      (user_id, action, entity_type, entity_id, before_json, after_json, ip, user_agent)
    VALUES
      ($1, $2, 'chain', $3, $4, $5, $6, $7)
    `,
    [
      req.admin?.id || null,
      action,
      entityId,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      req.ip,
      req.headers['user-agent'] || null,
    ]
  )
}

router.get('/', requireViewer, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT *
      FROM chains
      ORDER BY position ASC, name ASC
      `
    )

    res.json({
      chains: result.rows,
      updatedAt: new Date().toISOString(),
    })
  } catch (e) {
    console.error('[adminChains] list error:', e.message)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.get('/:id', requireViewer, async (req, res) => {
  const id = String(req.params.id || '').toLowerCase()

  if (!ID_REGEX.test(id)) {
    return res.status(400).json({ error: 'Chain id no válido' })
  }

  try {
    const result = await pool.query(
      `SELECT * FROM chains WHERE id = $1`,
      [id]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Blockchain no encontrada' })
    }

    res.json({ chain: result.rows[0] })
  } catch (e) {
    console.error('[adminChains] get error:', e.message)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.post('/', requireAdmin, async (req, res) => {
  const id = cleanString(req.body.id, 50)?.toLowerCase()
  const name = cleanString(req.body.name, 120)
  const displayName = cleanString(req.body.display_name ?? req.body.displayName ?? req.body.name, 120)
  const symbol = cleanString(req.body.symbol, 20)?.toUpperCase()
  const enabled = typeof req.body.enabled === 'boolean' ? req.body.enabled : false
  const position = toInt(req.body.position, 99)

  const rpc = req.body.rpc ? cleanUrl(req.body.rpc) : null
  const explorer = req.body.explorer ? cleanUrl(req.body.explorer) : null
  const logo = req.body.logo ? cleanUrl(req.body.logo) : null

  if (!id || !ID_REGEX.test(id)) {
    return res.status(400).json({ error: 'Chain id no válido' })
  }

  if (!name || name.length < 2) {
    return res.status(400).json({ error: 'Nombre no válido' })
  }

  if (!symbol || symbol.length < 2) {
    return res.status(400).json({ error: 'Símbolo no válido' })
  }

  if (req.body.rpc && !rpc) {
    return res.status(400).json({ error: 'RPC URL no válida' })
  }

  if (req.body.explorer && !explorer) {
    return res.status(400).json({ error: 'Explorer URL no válida' })
  }

  if (req.body.logo && !logo) {
    return res.status(400).json({ error: 'Logo URL no válida' })
  }

  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const beforeResult = await client.query(
      `SELECT * FROM chains WHERE id = $1`,
      [id]
    )

    const before = beforeResult.rows[0] || null

    const result = await client.query(
      `
      INSERT INTO chains
        (id, name, display_name, symbol, enabled, position, rpc, explorer, logo, updated_at)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        display_name = EXCLUDED.display_name,
        symbol = EXCLUDED.symbol,
        enabled = EXCLUDED.enabled,
        position = EXCLUDED.position,
        rpc = EXCLUDED.rpc,
        explorer = EXCLUDED.explorer,
        logo = EXCLUDED.logo,
        updated_at = NOW()
      RETURNING *
      `,
      [
        id,
        name,
        displayName,
        symbol,
        enabled,
        position,
        rpc,
        explorer,
        logo,
      ]
    )

    const after = result.rows[0]

    await writeAudit(
      client,
      req,
      before ? 'chain.upsert' : 'chain.create',
      id,
      before,
      after
    )

    await client.query('COMMIT')

    res.json({
      success: true,
      chain: after,
    })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[adminChains] create error:', e.message)
    res.status(500).json({ error: 'Error interno' })
  } finally {
    client.release()
  }
})

router.patch('/:id', requireAdmin, async (req, res) => {
  const id = String(req.params.id || '').toLowerCase()

  if (!ID_REGEX.test(id)) {
    return res.status(400).json({ error: 'Chain id no válido' })
  }

  const fields = []
  const values = []
  let i = 1

  function addField(column, value) {
    fields.push(`${column} = $${i}`)
    values.push(value)
    i++
  }

  if (req.body.name !== undefined) {
    const name = cleanString(req.body.name, 120)
    if (!name || name.length < 2) {
      return res.status(400).json({ error: 'Nombre no válido' })
    }
    addField('name', name)
  }

  if (req.body.display_name !== undefined || req.body.displayName !== undefined) {
    const displayName = cleanString(req.body.display_name ?? req.body.displayName, 120)
    addField('display_name', displayName)
  }

  if (req.body.symbol !== undefined) {
    const symbol = cleanString(req.body.symbol, 20)?.toUpperCase()
    if (!symbol || symbol.length < 2) {
      return res.status(400).json({ error: 'Símbolo no válido' })
    }
    addField('symbol', symbol)
  }

  if (req.body.enabled !== undefined) {
    if (typeof req.body.enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled debe ser true o false' })
    }
    addField('enabled', req.body.enabled)
  }

  if (req.body.position !== undefined) {
    addField('position', toInt(req.body.position, 99))
  }

  if (req.body.rpc !== undefined) {
    const rpc = req.body.rpc ? cleanUrl(req.body.rpc) : null
    if (req.body.rpc && !rpc) {
      return res.status(400).json({ error: 'RPC URL no válida' })
    }
    addField('rpc', rpc)
  }

  if (req.body.explorer !== undefined) {
    const explorer = req.body.explorer ? cleanUrl(req.body.explorer) : null
    if (req.body.explorer && !explorer) {
      return res.status(400).json({ error: 'Explorer URL no válida' })
    }
    addField('explorer', explorer)
  }

  if (req.body.logo !== undefined) {
    const logo = req.body.logo ? cleanUrl(req.body.logo) : null
    if (req.body.logo && !logo) {
      return res.status(400).json({ error: 'Logo URL no válida' })
    }
    addField('logo', logo)
  }

  if (fields.length === 0) {
    return res.status(400).json({ error: 'No hay campos para actualizar' })
  }

  fields.push('updated_at = NOW()')
  values.push(id)

  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const beforeResult = await client.query(
      `SELECT * FROM chains WHERE id = $1`,
      [id]
    )

    const before = beforeResult.rows[0]

    if (!before) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Blockchain no encontrada' })
    }

    const result = await client.query(
      `
      UPDATE chains
      SET ${fields.join(', ')}
      WHERE id = $${i}
      RETURNING *
      `,
      values
    )

    const after = result.rows[0]

    await writeAudit(client, req, 'chain.update', id, before, after)

    await client.query('COMMIT')

    res.json({
      success: true,
      chain: after,
    })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[adminChains] update error:', e.message)
    res.status(500).json({ error: 'Error interno' })
  } finally {
    client.release()
  }
})

router.post('/reorder', requireAdmin, async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : null

  if (!items) {
    return res.status(400).json({ error: 'items debe ser un array' })
  }

  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const beforeResult = await client.query(
      `SELECT id, position FROM chains ORDER BY position ASC`
    )

    for (const item of items) {
      const id = cleanString(item.id, 50)?.toLowerCase()
      const position = toInt(item.position, 99)

      if (!id || !ID_REGEX.test(id)) {
        throw new Error('Chain id no válido en reorder')
      }

      await client.query(
        `
        UPDATE chains
        SET position = $1, updated_at = NOW()
        WHERE id = $2
        `,
        [position, id]
      )
    }

    const afterResult = await client.query(
      `SELECT id, position FROM chains ORDER BY position ASC`
    )

    await writeAudit(
      client,
      req,
      'chain.reorder',
      'chains',
      beforeResult.rows,
      afterResult.rows
    )

    await client.query('COMMIT')

    res.json({
      success: true,
      chains: afterResult.rows,
    })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[adminChains] reorder error:', e.message)
    res.status(500).json({ error: e.message || 'Error interno' })
  } finally {
    client.release()
  }
})

router.delete('/:id', requireAdmin, async (req, res) => {
  const id = String(req.params.id || '').toLowerCase()

  if (!ID_REGEX.test(id)) {
    return res.status(400).json({ error: 'Chain id no válido' })
  }

  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const beforeResult = await client.query(
      `SELECT * FROM chains WHERE id = $1`,
      [id]
    )

    const before = beforeResult.rows[0]

    if (!before) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Blockchain no encontrada' })
    }

    const result = await client.query(
      `
      UPDATE chains
      SET enabled = false, updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [id]
    )

    const after = result.rows[0]

    await writeAudit(client, req, 'chain.disable', id, before, after)

    await client.query('COMMIT')

    res.json({
      success: true,
      chain: after,
    })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[adminChains] disable error:', e.message)
    res.status(500).json({ error: 'Error interno' })
  } finally {
    client.release()
  }
})

module.exports = router
