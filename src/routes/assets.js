/**
 * routes/assets.js
 * Gestión de blockchains y tokens disponibles en TapForge.
 *
 * Endpoints:
 *   GET /assets/chains          → lista de blockchains disponibles
 *   GET /assets/chains/:chainId → tokens de una blockchain
 *   GET /assets/sync            → sincroniza tokens de Klever API (admin)
 *
 * Seguridad:
 *   - Rate limiting por IP
 *   - Sin autenticación de momento (datos públicos)
 *   - /sync requiere ADMIN_SECRET en header
 *
 * Cache:
 *   - Datos en memoria con TTL de 1 hora
 *   - Sincronización manual o vía cron
 */

const express = require('express');
const router  = express.Router();

const KLEVER_API   = 'https://api.mainnet.klever.org/v1.0';
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? 'tapforge-admin-secret';
const CACHE_TTL    = 60 * 60 * 1000; // 1 hora

// ─── Cache en memoria ─────────────────────────────────────────────────────
let cachedTokens   = null;
let cacheTimestamp = 0;

function isCacheValid() {
  return cachedTokens !== null && (Date.now() - cacheTimestamp) < CACHE_TTL;
}

// ─── Datos base de blockchains ─────────────────────────────────────────────
// La lista de chains la controlamos nosotros — no viene de Klever
const CHAINS = [
  {
    id:       'klever',
    name:     'Klever Blockchain',
    symbol:   'KLV',
    enabled:  true,
    position: 1,
    rpc:      'https://node.mainnet.klever.org',
    explorer: 'https://kleverscan.org',
  },
  {
    id:       'tron',
    name:     'Tron',
    symbol:   'TRX',
    enabled:  false,
    position: 2,
    rpc:      'https://api.trongrid.io',
    explorer: 'https://tronscan.org',
  },
  {
    id:       'ethereum',
    name:     'Ethereum',
    symbol:   'ETH',
    enabled:  false,
    position: 3,
    rpc:      null,
    explorer: 'https://etherscan.io',
  },
  {
    id:       'bitcoin',
    name:     'Bitcoin',
    symbol:   'BTC',
    enabled:  false,
    position: 4,
    rpc:      null,
    explorer: 'https://blockstream.info',
  },
];

// ─── Tokens por defecto de Klever (antes de sincronizar) ───────────────────
// featured = true → aparece activado por defecto para usuarios nuevos
const DEFAULT_KLEVER_TOKENS = [
  { id: 'KLV',        name: 'Klever',         symbol: 'KLV',   precision: 6, featured: true,  logo: null },
  { id: 'KFI',        name: 'Klever Finance', symbol: 'KFI',   precision: 6, featured: true,  logo: null },
  { id: 'DVK-34ZH',   name: 'Duovek',         symbol: 'DVK',   precision: 6, featured: false, logo: null },
  { id: 'KUNAI-18TK', name: 'Kunai',          symbol: 'KUNAI', precision: 6, featured: false, logo: null },
  { id: 'USDT-23V8',  name: 'Tether USD',     symbol: 'USDT',  precision: 6, featured: false, logo: null },
];

// Tokens de otras chains (pendientes de implementar en la app)
const TRON_TOKENS = [
  { id: 'TRX',        name: 'Tron',           symbol: 'TRX',   precision: 6, featured: true,  logo: null },
  { id: 'USDT-TRC20', name: 'Tether USD',     symbol: 'USDT',  precision: 6, featured: true,  logo: null },
];

// ─── Función de sincronización con Klever API ──────────────────────────────
async function syncKleverTokens() {
  try {
    console.log('[assets] Sincronizando tokens de Klever API...');
    const allTokens = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const res = await fetch(`${KLEVER_API}/assets?page=${page}&limit=50`);
      if (!res.ok) break;

      const data = await res.json();
      const assets = data?.data?.assets ?? [];

      for (const asset of assets) {
        // Solo tokens fungibles (tipo 0)
        if (asset.assetType !== 0 && asset.assetType !== 'Fungible') continue;

        allTokens.push({
          id:        asset.assetId ?? asset.ticker,
          name:      asset.name,
          symbol:    asset.ticker,
          precision: asset.precision ?? 6,
          featured:  DEFAULT_KLEVER_TOKENS.some(t => t.id === (asset.assetId ?? asset.ticker)),
          logo:      asset.logo ?? null,
        })
      }

      // Si volvemos menos de 50, ya no hay más páginas
      hasMore = assets.length === 50
      page++

      // Límite de seguridad — máximo 20 páginas (1000 tokens)
      if (page > 20) break
    }

    if (allTokens.length > 0) {
      cachedTokens   = allTokens
      cacheTimestamp = Date.now()
      console.log(`[assets] Sincronizados ${allTokens.length} tokens de Klever`)
    }

    return allTokens.length
  } catch (e) {
    console.error('[assets] Error sincronizando:', e.message)
    return 0
  }
}

// ─── GET /assets/chains ────────────────────────────────────────────────────
// Devuelve la lista de blockchains disponibles
router.get('/chains', (req, res) => {
  res.json({
    chains: CHAINS,
    updatedAt: new Date().toISOString(),
  })
})

// ─── GET /assets/chains/:chainId ──────────────────────────────────────────
// Devuelve los tokens de una blockchain específica
router.get('/chains/:chainId', (req, res) => {
  const { chainId } = req.params
  const chain = CHAINS.find(c => c.id === chainId)

  if (!chain) {
    return res.status(404).json({ error: `Blockchain '${chainId}' no encontrada` })
  }

  let tokens = []

  if (chainId === 'klever') {
    // Si tenemos cache sincronizado usamos ese, si no los defaults
    tokens = isCacheValid() ? cachedTokens : DEFAULT_KLEVER_TOKENS
  } else if (chainId === 'tron') {
    tokens = TRON_TOKENS
  }

  res.json({
    chain,
    tokens,
    total:       tokens.length,
    cacheValid:  chainId === 'klever' ? isCacheValid() : true,
    updatedAt:   chainId === 'klever' && isCacheValid()
      ? new Date(cacheTimestamp).toISOString()
      : new Date().toISOString(),
  })
})

// ─── POST /assets/sync ────────────────────────────────────────────────────
// Sincroniza tokens desde Klever API — requiere ADMIN_SECRET
router.post('/sync', async (req, res) => {
  const secret = req.headers['x-admin-secret']
  if (secret !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'No autorizado' })
  }

  const count = await syncKleverTokens()
  res.json({
    success: count > 0,
    synced:  count,
    message: count > 0
      ? `${count} tokens sincronizados correctamente`
      : 'Error en la sincronización — revisa los logs',
  })
})

// ─── GET /assets/sync/status ──────────────────────────────────────────────
// Estado del cache de sincronización
router.get('/sync/status', (req, res) => {
  res.json({
    cacheValid:  isCacheValid(),
    tokenCount:  cachedTokens?.length ?? 0,
    lastSync:    cacheTimestamp > 0 ? new Date(cacheTimestamp).toISOString() : null,
    nextSync:    cacheTimestamp > 0
      ? new Date(cacheTimestamp + CACHE_TTL).toISOString()
      : null,
  })
})

module.exports = router
