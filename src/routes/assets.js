/**
 * routes/assets.js
 * Gestión de blockchains y tokens — con PostgreSQL.
 */

const express = require('express')
const router = express.Router()
const { pool } = require('../db')

const KLEVER_API = 'https://api.mainnet.klever.org/v1.0'
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? 'tapforge-admin-secret'

const PARAM_REGEX = /^[a-zA-Z0-9_\-]{1,50}$/

function isAdmin(req) {
  return req.headers['x-admin-secret'] === ADMIN_SECRET
}

function validateChainId(chainId) {
  return PARAM_REGEX.test(chainId)
}

function validateTokenId(tokenId) {
  return PARAM_REGEX.test(tokenId)
}

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

function toBool(value, fallback = false) {
  if (typeof value === 'boolean') return value
  return fallback
}

function toInt(value, fallback = 99) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

// ─── GET /assets/chains ───────────────────────────────────────────────────

router.get('/chains', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM chains ORDER BY position ASC, name ASC'
    )

    res.json({
      chains: result.rows,
      updatedAt: new Date().toISOString(),
    })
  } catch (e) {
    console.error('[assets] Error obteniendo chains:', e.message)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── POST /assets/chains ──────────────────────────────────────────────────
// Admin: crear o actualizar blockchain

router.post('/chains', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'No autorizado' })
  }

  const id = cleanString(req.body.id, 50)?.toLowerCase()
  const name = cleanString(req.body.name, 120)
  const displayName = cleanString(req.body.display_name ?? req.body.displayName ?? req.body.name, 120)
  const symbol = cleanString(req.body.symbol, 20)?.toUpperCase()
  const enabled = toBool(req.body.enabled, false)
  const position = toInt(req.body.position, 99)
  const rpc = cleanUrl(req.body.rpc)
  const explorer = cleanUrl(req.body.explorer)
  const logo = cleanUrl(req.body.logo)

  if (!id || !validateChainId(id)) {
    return res.status(400).json({ error: 'Chain id no válido' })
  }

  if (!name || name.length < 2) {
    return res.status(400).json({ error: 'Nombre no válido' })
  }

  if (!symbol || symbol.length < 2) {
    return res.status(400).json({ error: 'Símbolo no válido' })
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO chains (
        id, name, display_name, symbol, enabled,
        position, rpc, explorer, logo, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
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

    res.json({
      success: true,
      chain: result.rows[0],
    })
  } catch (e) {
    console.error('[assets] Error creando chain:', e.message)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── PATCH /assets/chains/:chainId ────────────────────────────────────────
// Admin: editar blockchain

router.patch('/chains/:chainId', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'No autorizado' })
  }

  const { chainId } = req.params

  if (!validateChainId(chainId)) {
    return res.status(400).json({ error: `Blockchain '${chainId}' no válida` })
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
    if (!name || name.length < 2) return res.status(400).json({ error: 'Nombre no válido' })
    addField('name', name)
  }

  if (req.body.display_name !== undefined || req.body.displayName !== undefined) {
    const displayName = cleanString(req.body.display_name ?? req.body.displayName, 120)
    addField('display_name', displayName)
  }

  if (req.body.symbol !== undefined) {
    const symbol = cleanString(req.body.symbol, 20)?.toUpperCase()
    if (!symbol || symbol.length < 2) return res.status(400).json({ error: 'Símbolo no válido' })
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
    if (req.body.rpc && !rpc) return res.status(400).json({ error: 'RPC URL no válida' })
    addField('rpc', rpc)
  }

  if (req.body.explorer !== undefined) {
    const explorer = req.body.explorer ? cleanUrl(req.body.explorer) : null
    if (req.body.explorer && !explorer) return res.status(400).json({ error: 'Explorer URL no válida' })
    addField('explorer', explorer)
  }

  if (req.body.logo !== undefined) {
    const logo = req.body.logo ? cleanUrl(req.body.logo) : null
    if (req.body.logo && !logo) return res.status(400).json({ error: 'Logo URL no válida' })
    addField('logo', logo)
  }

  if (fields.length === 0) {
    return res.status(400).json({ error: 'No hay campos para actualizar' })
  }

  fields.push('updated_at = NOW()')
  values.push(chainId)

  try {
    const result = await pool.query(
      `
      UPDATE chains
      SET ${fields.join(', ')}
      WHERE id = $${i}
      RETURNING *
      `,
      values
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: `Blockchain '${chainId}' no encontrada` })
    }

    res.json({
      success: true,
      chain: result.rows[0],
    })
  } catch (e) {
    console.error('[assets] Error actualizando chain:', e.message)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── GET /assets/chains/:chainId ─────────────────────────────────────────
// Tokens de una blockchain

router.get('/chains/:chainId', async (req, res) => {
  const { chainId } = req.params
  const page = Math.max(1, parseInt(req.query.page ?? '1'))
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit ?? '20')))
  const search = (req.query.search ?? '').trim().toLowerCase()
  const offset = (page - 1) * limit

  if (!validateChainId(chainId)) {
    return res.status(400).json({ error: 'Chain id no válido' })
  }

  try {
    const chainResult = await pool.query(
      'SELECT * FROM chains WHERE id = $1',
      [chainId]
    )

    if (chainResult.rows.length === 0) {
      return res.status(404).json({ error: `Blockchain '${chainId}' no encontrada` })
    }

    const countResult = await pool.query(
      `
      SELECT COUNT(*)
      FROM tokens
      WHERE chain_id = $1
        AND ($2 = '' OR LOWER(symbol) LIKE $3 OR LOWER(name) LIKE $3 OR LOWER(id) LIKE $3)
      `,
      [chainId, search, `%${search}%`]
    )

    const total = parseInt(countResult.rows[0].count)

    const tokensResult = await pool.query(
      `
      SELECT *
      FROM tokens
      WHERE chain_id = $1
        AND ($2 = '' OR LOWER(symbol) LIKE $3 OR LOWER(name) LIKE $3 OR LOWER(id) LIKE $3)
      ORDER BY featured DESC, symbol ASC
      LIMIT $4 OFFSET $5
      `,
      [chainId, search, `%${search}%`, limit, offset]
    )

    res.json({
      chain: chainResult.rows[0],
      tokens: tokensResult.rows,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      hasMore: offset + tokensResult.rows.length < total,
      updatedAt: new Date().toISOString(),
    })
  } catch (e) {
    console.error('[assets] Error obteniendo tokens:', e.message)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── PATCH /assets/chains/:chainId/tokens/:tokenId ────────────────────────
// Admin: marcar token como destacado

router.patch('/chains/:chainId/tokens/:tokenId', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'No autorizado' })
  }

  const { chainId, tokenId } = req.params

  if (!validateChainId(chainId)) {
    return res.status(400).json({ error: `Blockchain '${chainId}' no válida` })
  }

  if (!validateTokenId(tokenId)) {
    return res.status(400).json({
      error: 'Token ID no válido — solo letras, números, guiones y guiones bajos',
    })
  }

  const { featured } = req.body

  if (typeof featured !== 'boolean') {
    return res.status(400).json({ error: 'featured debe ser true o false' })
  }

  try {
    const result = await pool.query(
      `
      UPDATE tokens
      SET featured = $1
      WHERE id = $2 AND chain_id = $3
      RETURNING id, chain_id, name, symbol, featured
      `,
      [featured, tokenId, chainId]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: `Token '${tokenId}' no encontrado en '${chainId}'` })
    }

    res.json({
      success: true,
      token: result.rows[0],
    })
  } catch (e) {
    console.error('[assets] Error actualizando token:', e.message)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── POST /assets/sync ────────────────────────────────────────────────────
// Admin: sincroniza tokens desde Klever API

router.post('/sync', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'No autorizado' })
  }

  try {
    console.log('[assets] Iniciando sincronización con Klever API...')

    const allTokens = []
    let page = 1
    let hasMore = true

    while (hasMore) {
      const response = await fetch(`${KLEVER_API}/assets/list?page=${page}&limit=50`)
      if (!response.ok) break

      const data = await response.json()
      const assets = data?.data?.assets ?? []

      for (const asset of assets) {
        if (asset.assetType !== 'Fungible') continue

        allTokens.push({
          id: asset.assetId,
          chain_id: 'klever',
          name: asset.name ?? asset.ticker,
          symbol: asset.ticker,
          precision: asset.precision ?? 6,
          logo: asset.logo ?? null,
        })
      }

      hasMore = assets.length === 50
      page++
      if (page > 20) break
    }

    if (allTokens.length === 0) {
      return res.status(500).json({ error: 'No se obtuvieron tokens de Klever API' })
    }

    const FEATURED = ['KLV', 'KFI', 'DVK-34ZH', 'KUNAI-18TK']

    const client = await pool.connect()

    try {
      await client.query('BEGIN')

      for (const token of allTokens) {
        await client.query(
          `
          INSERT INTO tokens (id, chain_id, name, symbol, precision, featured, logo, synced_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
          ON CONFLICT (id, chain_id) DO UPDATE SET
            name = EXCLUDED.name,
            symbol = EXCLUDED.symbol,
            precision = EXCLUDED.precision,
            logo = EXCLUDED.logo,
            synced_at = NOW()
          `,
          [
            token.id,
            token.chain_id,
            token.name,
            token.symbol,
            token.precision,
            FEATURED.includes(token.id),
            token.logo,
          ]
        )
      }

      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }

    res.json({
      success: true,
      synced: allTokens.length,
      message: `${allTokens.length} tokens sincronizados correctamente`,
    })
  } catch (e) {
    console.error('[assets] Error en sincronización:', e.message)
    res.status(500).json({ error: 'Error en la sincronización' })
  }
})

// ─── GET /assets/sync/status ──────────────────────────────────────────────

router.get('/sync/status', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) AS total_tokens,
        MAX(synced_at) AS last_sync,
        COUNT(*) FILTER (WHERE chain_id = 'klever') AS klever_tokens
      FROM tokens
    `)

    res.json({
      totalTokens: parseInt(result.rows[0].total_tokens),
      kleverTokens: parseInt(result.rows[0].klever_tokens),
      lastSync: result.rows[0].last_sync,
    })
  } catch (e) {
    res.status(500).json({ error: 'Error interno' })
  }
})

module.exports = router
