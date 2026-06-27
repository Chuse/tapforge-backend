/**
 * routes/assets.js
 * Gestión de blockchains y tokens — con PostgreSQL.
 */

const express = require('express')
const router = express.Router()
const { pool } = require('../db')
const { isR2Configured, mirrorLogo, publicUrlForKey } = require('../r2')
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3')

const KLEVER_API = 'https://api.mainnet.klever.org/v1.0'
// El admin secret SOLO viene de la variable de entorno. Sin fallback: un valor
// por defecto conocido (y en un repo público) sería un agujero de seguridad.
const ADMIN_SECRET = process.env.ADMIN_SECRET

const PARAM_REGEX = /^[a-zA-Z0-9_\-]{1,50}$/

function isAdmin(req) {
  // Si no hay secreto configurado, denegar SIEMPRE (nunca abrir admin por defecto).
  if (!ADMIN_SECRET) return false
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

// Decimales de la moneda NATIVA por símbolo (no están en la tabla chains).
// Coincide con CHAIN_CONFIGS del cliente (walletTypes.ts).
const NATIVE_DECIMALS = {
  KLV: 6, TRX: 6, ETH: 18, BTC: 8, POL: 18, MATIC: 18,
}

// Construye el "token" de la moneda nativa desde la fila de chains. El nativo no
// es un token de contrato (no tiene address): su id es el símbolo, y su logo es
// el de la chain (ya mirroreado a R2). El cliente lo muestra SIEMPRE primero.
function buildNativeToken(chain) {
  if (!chain) return null
  const symbol = chain.symbol
  return {
    id:        symbol,                          // el nativo se identifica por símbolo
    chain_id:  chain.id,
    name:      chain.display_name || chain.name,
    symbol,
    precision: NATIVE_DECIMALS[symbol] ?? 18,
    featured:  true,                            // el nativo siempre destacado
    logo:      chain.logo ?? null,              // logo de la chain (en R2)
    native:    true,                            // marca para el cliente
  }
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

    // Lazy mirror: tokens servidos cuyo logo sigue siendo externo se mirrorean
    // en segundo plano (NO bloquea la respuesta). La próxima carga ya sale de R2.
    if (isR2Configured()) {
      const base = process.env.R2_PUBLIC_BASE || '###'
      for (const tk of tokensResult.rows) {
        const isExternal = tk.logo && !tk.logo.startsWith(base)
        if (isExternal) {
          mirrorLogo(tk.chain_id, tk.id, tk.logo)
            .then(url => {
              if (url) {
                pool.query(
                  'UPDATE tokens SET logo = $1 WHERE id = $2 AND chain_id = $3',
                  [url, tk.id, tk.chain_id]
                ).catch(() => {})
              }
            })
            .catch(() => {})
        }
      }
    }

    res.json({
      chain: chainResult.rows[0],
      nativeToken: buildNativeToken(chainResult.rows[0]),
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
        const isFeatured = FEATURED.includes(token.id)

        // Mirror inmediato SOLO de featured. El resto se mirrorea lazy (al
        // pedirse en el GET). Si R2 no está configurado o el origen falla,
        // queda la URL externa como fallback (no rompe el sync).
        let logoUrl = token.logo
        if (isFeatured && isR2Configured() && token.logo) {
          const mirrored = await mirrorLogo(token.chain_id, token.id, token.logo)
          if (mirrored) logoUrl = mirrored
        }

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
            isFeatured,
            logoUrl,
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

// ─── GET /assets/r2-status ────────────────────────────────────────────────
// Diagnóstico: confirma que el backend ve las 5 variables R2, sin exponer valores.

router.get('/r2-status', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'No autorizado' })
  }

  const present = {
    R2_ENDPOINT:          Boolean(process.env.R2_ENDPOINT),
    R2_ACCESS_KEY_ID:     Boolean(process.env.R2_ACCESS_KEY_ID),
    R2_SECRET_ACCESS_KEY: Boolean(process.env.R2_SECRET_ACCESS_KEY),
    R2_BUCKET_NAME:       Boolean(process.env.R2_BUCKET_NAME),
    R2_PUBLIC_BASE:       Boolean(process.env.R2_PUBLIC_BASE),
  }
  const allPresent = Object.values(present).every(Boolean)

  res.json({
    configured: allPresent,
    present,
    hints: {
      bucket:                  process.env.R2_BUCKET_NAME || null,
      publicBase:              process.env.R2_PUBLIC_BASE || null,
      publicBaseTrailingSlash: (process.env.R2_PUBLIC_BASE || '').endsWith('/'),
      endpointLooksValid:      /^https:\/\/.+\.r2\.cloudflarestorage\.com/.test(process.env.R2_ENDPOINT || ''),
    },
    note: allPresent
      ? 'Todas presentes. Usa POST /assets/r2-test para probar escritura real.'
      : 'Faltan variables — el mirror no se activará hasta que estén las 5.',
  })
})

// ─── POST /assets/r2-test ─────────────────────────────────────────────────
// Diagnóstico: escribe un objeto de prueba, lo lee por URL pública y lo borra.

router.post('/r2-test', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'No autorizado' })
  }
  if (!isR2Configured()) {
    return res.status(400).json({ error: 'R2 no está configurado (faltan variables)' })
  }

  const client = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  })

  const testKey = `_diagnostico/test-${Date.now()}.txt`
  const result = { write: false, publicRead: false, delete: false, publicUrl: null }

  try {
    await client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: testKey,
      Body: Buffer.from('desna r2 ok'),
      ContentType: 'text/plain',
    }))
    result.write = true

    const publicUrl = `${process.env.R2_PUBLIC_BASE.replace(/\/$/, '')}/${testKey}`
    result.publicUrl = publicUrl
    try {
      const r = await fetch(publicUrl)
      result.publicRead = r.ok
    } catch {
      result.publicRead = false
    }

    await client.send(new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: testKey,
    }))
    result.delete = true

    const ok = result.write && result.publicRead && result.delete
    res.json({
      ok,
      result,
      diagnosis: ok
        ? 'R2 totalmente operativo: escritura, lectura pública y borrado OK.'
        : !result.write
          ? 'Fallo la ESCRITURA — revisa credenciales o permisos del token.'
          : !result.publicRead
            ? 'Escritura OK pero LECTURA PUBLICA fallo — revisa acceso público del bucket y R2_PUBLIC_BASE.'
            : 'Escritura y lectura OK pero el borrado fallo — revisa permisos delete del token.',
    })
  } catch (e) {
    res.status(500).json({ ok: false, result, error: e.message,
      diagnosis: 'Error conectando a R2 — revisa R2_ENDPOINT y credenciales.' })
  }
})

// ─── POST /assets/sync-evm ────────────────────────────────────────────────
// Sincroniza tokens EVM curados (Ethereum, Base, Polygon) desde la Uniswap
// default token list. Mismo patrón que /sync: metadata curada + mirror a R2.
// El `id` de cada token EVM es su dirección de contrato (en minúsculas).

const UNISWAP_TOKENLIST = 'https://ipfs.io/ipns/tokens.uniswap.org'
const UNISWAP_TOKENLIST_FALLBACK = 'https://gateway.ipfs.io/ipns/tokens.uniswap.org'

// chainId EIP-155 → chain_id de la tabla (coincide con CHAIN_CONFIGS del cliente)
const EVM_CHAINID_MAP = {
  1:    'ethereum',
  8453: 'base',
  137:  'polygon',
}

// Featured: tokens grandes que se mirrorean a R2 de inmediato (el resto, lazy).
const EVM_FEATURED = new Set([
  'WETH', 'USDC', 'USDT', 'DAI', 'WBTC', 'UNI', 'LINK', 'AAVE',
])

async function fetchUniswapTokenList() {
  for (const url of [UNISWAP_TOKENLIST, UNISWAP_TOKENLIST_FALLBACK]) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } })
      if (r.ok) return await r.json()
    } catch { /* probar siguiente */ }
  }
  throw new Error('No se pudo descargar la token list de Uniswap')
}

router.post('/sync-evm', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'No autorizado' })
  }

  try {
    console.log('[assets] Sincronizando tokens EVM (Uniswap list)...')

    const list = await fetchUniswapTokenList()
    const tokens = Array.isArray(list?.tokens) ? list.tokens : []
    if (tokens.length === 0) {
      return res.status(500).json({ error: 'La token list vino vacía' })
    }

    // Leer qué chains existen DE VERDAD en la tabla (evita violar la FK si una
    // chain del mapa, p.ej. polygon, aún no está creada). Solo metemos tokens
    // de chains presentes; las demás se ignoran sin romper el sync.
    const existing = await pool.query('SELECT id FROM chains')
    const existingChains = new Set(existing.rows.map(r => r.id))

    const rows = []
    for (const t of tokens) {
      const chainId = EVM_CHAINID_MAP[t.chainId]
      if (!chainId) continue                      // chain no soportada por el mapa
      if (!existingChains.has(chainId)) continue  // chain no creada en la tabla
      if (!t.address || !t.symbol) continue

      rows.push({
        id:        String(t.address).toLowerCase(),
        chain_id:  chainId,
        name:      t.name ?? t.symbol,
        symbol:    t.symbol,
        precision: Number.isFinite(t.decimals) ? t.decimals : 18,
        logo:      t.logoURI ?? null,
        featured:  EVM_FEATURED.has(String(t.symbol).toUpperCase()),
      })
    }

    if (rows.length === 0) {
      return res.status(500).json({ error: 'No hay tokens de chains soportadas en la lista' })
    }

    const client = await pool.connect()
    let mirrored = 0

    try {
      await client.query('BEGIN')

      for (const token of rows) {
        let logoUrl = token.logo
        if (token.featured && isR2Configured() && token.logo) {
          const url = await mirrorLogo(token.chain_id, token.id, token.logo)
          if (url) { logoUrl = url; mirrored++ }
        }

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
            token.featured,
            logoUrl,
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

    const byChain = {}
    for (const r of rows) byChain[r.chain_id] = (byChain[r.chain_id] || 0) + 1

    res.json({
      success: true,
      synced: rows.length,
      mirrored,
      byChain,
      message: `${rows.length} tokens EVM sincronizados (${mirrored} logos featured a R2)`,
    })
  } catch (e) {
    console.error('[assets] Error sync EVM:', e.message)
    res.status(500).json({ error: 'Error en la sincronización EVM', detail: e.message })
  }
})

// ─── POST /assets/sync-tron ───────────────────────────────────────────────
// Sincroniza los TRC-20 líderes de Tron desde una lista CURADA embebida.
// Para Tron no hay buena fuente automática (Trust Wallet casi vacía, TronScan
// con rate limits), y la chain solo tiene un puñado de tokens relevantes — el
// 95% del volumen es USDT. Una lista curada a mano es más fiable.
// Direcciones verificadas contra TRON Guide / Gem Wallet / Dwellir (2026).
// OJO: direcciones Base58 case-sensitive — NO normalizar a minúsculas.
// Logos desde el CDN de Trust Wallet (fiable, aunque su tokenlist esté vacía).

const TRON_LOGO_BASE = 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/tron/assets'

const TRON_CURATED = [
  { id: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', symbol: 'USDT', name: 'Tether USD',       decimals: 6,  featured: true },
  { id: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8', symbol: 'USDC', name: 'USD Coin',         decimals: 6,  featured: true },
  { id: 'TPYmHEhy5n8TCEfYGqW2rPxsghSfzghPDn', symbol: 'USDD', name: 'Decentralized USD', decimals: 18, featured: true },
  { id: 'TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9', symbol: 'JST',  name: 'JUST',             decimals: 18, featured: true },
  { id: 'TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S', symbol: 'SUN',  name: 'SUN',              decimals: 18, featured: true },
  { id: 'TAFjULxiVgT4qWk6UZwjqwZXTSaGaqnVp4', symbol: 'BTT',  name: 'BitTorrent',       decimals: 18, featured: false },
  { id: 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7', symbol: 'WIN',  name: 'WINkLink',         decimals: 6,  featured: false },
  { id: 'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR', symbol: 'WTRX', name: 'Wrapped TRX',      decimals: 6,  featured: false },
]

router.post('/sync-tron', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'No autorizado' })
  }

  try {
    console.log('[assets] Sincronizando TRC-20 curados...')

    const existing = await pool.query("SELECT id FROM chains WHERE id = 'tron'")
    if (existing.rows.length === 0) {
      return res.status(400).json({ error: "La chain 'tron' no existe en la tabla chains" })
    }

    const client = await pool.connect()
    let mirrored = 0

    try {
      await client.query('BEGIN')

      for (const token of TRON_CURATED) {
        const externalLogo = `${TRON_LOGO_BASE}/${token.id}/logo.png`

        // Mirror SOLO de featured (los grandes). El resto, lazy en el GET.
        let logoUrl = externalLogo
        if (token.featured && isR2Configured()) {
          const url = await mirrorLogo('tron', token.id, externalLogo)
          if (url) { logoUrl = url; mirrored++ }
        }

        await client.query(
          `
          INSERT INTO tokens (id, chain_id, name, symbol, precision, featured, logo, synced_at)
          VALUES ($1, 'tron', $2, $3, $4, $5, $6, NOW())
          ON CONFLICT (id, chain_id) DO UPDATE SET
            name = EXCLUDED.name,
            symbol = EXCLUDED.symbol,
            precision = EXCLUDED.precision,
            featured = EXCLUDED.featured,
            logo = EXCLUDED.logo,
            synced_at = NOW()
          `,
          [token.id, token.name, token.symbol, token.decimals, token.featured, logoUrl]
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
      synced: TRON_CURATED.length,
      mirrored,
      message: `${TRON_CURATED.length} TRC-20 curados sincronizados (${mirrored} logos featured a R2)`,
    })
  } catch (e) {
    console.error('[assets] Error sync Tron:', e.message)
    res.status(500).json({ error: 'Error en la sincronización Tron', detail: e.message })
  }
})

// ─── POST /assets/sync-chain-logos ────────────────────────────────────────
// Mirrorea a R2 los logos de las CHAINS (no de los tokens). Estos logos se usan
// también como icono de la MONEDA NATIVA (TRX, ETH, KLV) en el cliente, así que
// conviene que salgan de nuestro storage y no de Trust Wallet.
// Guarda en chains.logo la URL de R2 (clave: chain-logos/{chainId}).

router.post('/sync-chain-logos', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'No autorizado' })
  }
  if (!isR2Configured()) {
    return res.status(400).json({ error: 'R2 no está configurado' })
  }

  try {
    const chains = await pool.query('SELECT id, logo FROM chains')
    const base = process.env.R2_PUBLIC_BASE
    let mirrored = 0
    const results = []

    for (const chain of chains.rows) {
      // Saltar si no tiene logo o ya está en R2
      if (!chain.logo || chain.logo.startsWith(base)) {
        results.push({ chain: chain.id, status: chain.logo ? 'ya en R2' : 'sin logo' })
        continue
      }

      // Mirror con clave especial chain-logos/{id} (no logos/{chain}/{token})
      const url = await mirrorLogo('chain-logos', chain.id, chain.logo)
      if (url) {
        await pool.query('UPDATE chains SET logo = $1, updated_at = NOW() WHERE id = $2', [url, chain.id])
        mirrored++
        results.push({ chain: chain.id, status: 'mirroreado', url })
      } else {
        results.push({ chain: chain.id, status: 'fallo (origen no accesible)' })
      }
    }

    res.json({ success: true, mirrored, results })
  } catch (e) {
    console.error('[assets] Error sync chain logos:', e.message)
    res.status(500).json({ error: 'Error mirroreando logos de chains', detail: e.message })
  }
})

module.exports = router
