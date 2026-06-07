/**
 * routes/assets.js
 * Gestión de blockchains y tokens — con PostgreSQL.
 *
 * GET  /assets/chains              → lista de blockchains
 * GET  /assets/chains/:chainId     → tokens de una blockchain
 * POST /assets/sync                → sincroniza tokens desde Klever API (admin)
 * GET  /assets/sync/status         → estado de la última sincronización
 */

const express    = require('express')
const router     = express.Router()
const { pool }   = require('../db')

const KLEVER_API   = 'https://api.mainnet.klever.org/v1.0'
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? 'tapforge-admin-secret'

// ─── GET /assets/chains ───────────────────────────────────────────────────
router.get('/chains', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM chains ORDER BY position ASC'
    )
    res.json({
      chains:    result.rows,
      updatedAt: new Date().toISOString(),
    })
  } catch (e) {
    console.error('[assets] Error obteniendo chains:', e.message)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── GET /assets/chains/:chainId ─────────────────────────────────────────
router.get('/chains/:chainId', async (req, res) => {
  const { chainId } = req.params
  try {
    const chainResult = await pool.query(
      'SELECT * FROM chains WHERE id = $1',
      [chainId]
    )
    if (chainResult.rows.length === 0) {
      return res.status(404).json({ error: `Blockchain '${chainId}' no encontrada` })
    }

    const tokensResult = await pool.query(
      'SELECT * FROM tokens WHERE chain_id = $1 ORDER BY featured DESC, symbol ASC',
      [chainId]
    )

    res.json({
      chain:     chainResult.rows[0],
      tokens:    tokensResult.rows,
      total:     tokensResult.rows.length,
      updatedAt: new Date().toISOString(),
    })
  } catch (e) {
    console.error('[assets] Error obteniendo tokens:', e.message)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── POST /assets/sync ────────────────────────────────────────────────────
router.post('/sync', async (req, res) => {
  const secret = req.headers['x-admin-secret']
  if (secret !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'No autorizado' })
  }

  try {
    console.log('[assets] Iniciando sincronización con Klever API...')
    const allTokens = []
    let page    = 1
    let hasMore = true

    while (hasMore) {
      const response = await fetch(`${KLEVER_API}/assets?page=${page}&limit=50`)
      if (!response.ok) break

      const data   = await response.json()
      const assets = data?.data?.assets ?? []

      for (const asset of assets) {
        // Solo tokens fungibles
        if (asset.assetType !== 0 && asset.assetType !== 'Fungible') continue

        allTokens.push({
          id:        asset.assetId ?? asset.ticker,
          chain_id:  'klever',
          name:      asset.name ?? asset.ticker,
          symbol:    asset.ticker,
          precision: asset.precision ?? 6,
          logo:      asset.logo ?? null,
        })
      }

      hasMore = assets.length === 50
      page++
      if (page > 20) break  // Límite de seguridad
    }

    if (allTokens.length === 0) {
      return res.status(500).json({ error: 'No se obtuvieron tokens de Klever API' })
    }

    // Tokens que siempre son featured
    const FEATURED = ['KLV', 'KFI', 'DVK-34ZH', 'KUNAI-18TK']

    // Upsert en base de datos
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      for (const token of allTokens) {
        await client.query(`
          INSERT INTO tokens (id, chain_id, name, symbol, precision, featured, logo, synced_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
          ON CONFLICT (id, chain_id) DO UPDATE SET
            name      = EXCLUDED.name,
            symbol    = EXCLUDED.symbol,
            precision = EXCLUDED.precision,
            logo      = EXCLUDED.logo,
            synced_at = NOW()
        `, [
          token.id,
          token.chain_id,
          token.name,
          token.symbol,
          token.precision,
          FEATURED.includes(token.id),
          token.logo,
        ])
      }

      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }

    console.log(`[assets] Sincronizados ${allTokens.length} tokens de Klever`)
    res.json({
      success:  true,
      synced:   allTokens.length,
      message:  `${allTokens.length} tokens sincronizados correctamente`,
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
        COUNT(*)                              AS total_tokens,
        MAX(synced_at)                        AS last_sync,
        COUNT(*) FILTER (WHERE chain_id = 'klever') AS klever_tokens
      FROM tokens
    `)
    res.json({
      totalTokens:  parseInt(result.rows[0].total_tokens),
      kleverTokens: parseInt(result.rows[0].klever_tokens),
      lastSync:     result.rows[0].last_sync,
    })
  } catch (e) {
    res.status(500).json({ error: 'Error interno' })
  }
})

module.exports = router
