/**
 * TapForge Swap Provider Configuration
 *
 * Define aquí los pares disponibles y qué proveedor los ejecuta.
 * Añadir un nuevo par o proveedor no requiere tocar la app móvil.
 *
 * Proveedores soportados:
 *   - "bitcoin.me"  → DEX nativo de KleverChain (sin API key, referral on-chain)
 *   - "changelly"   → CEX/bridge para pares externos (requiere API key)
 */

const REFERRAL_ADDRESS = process.env.TAPFORGE_REFERRAL_ADDRESS || '';
const REFERRAL_PERCENTAGE = 500; // 0.5% — base 100,000

// Dirección del contrato Referral de Bitcoin.me (mainnet)
const BITCOIN_ME_REFERRAL_CONTRACT = 'klv1qqqqqqqqqqqqqpgqjd9k34hzy53lsreq4drqkwfedqvtqen3x04sevtrjj';

// Dirección del contrato Router de Bitcoin.me (mainnet)
// Se obtiene de: GET https://api.bitcoin.me/router/config
const BITCOIN_ME_ROUTER_CONTRACT = 'klv1qqqqqqqqqqqqqpgqd9ds2tacasw7uc8q60wpm4qtn3kuswa2x04sz65vfc'; // placeholder — ver /router/config

const SWAP_PAIRS = [
  // ─── KLV ↔ Stablecoins ──────────────────────────────────────────────────
  {
    from: 'KLV',
    to: 'USDT',
    toAssetId: 'USDT-23V8',
    provider: 'bitcoin.me',
    poolAddress: 'klv1qqqqqqqqqqqqqpgqd9ds2tacasw7uc8q60wpm4qtn3kuswa2x04sz65vfc',
    liquidityUsd: 91240,
    enabled: true,
  },
  {
    from: 'KLV',
    to: 'USDC',
    toAssetId: 'USDC-1LN4',
    provider: 'bitcoin.me',
    poolAddress: 'klv1qqqqqqqqqqqqqpgqjszu6zla7vu5apzqk3s6pyfc3nen7pzux04s46aw67',
    liquidityUsd: 36936,
    enabled: true,
  },
  // ─── KLV ↔ Crypto principales ────────────────────────────────────────────
  {
    from: 'KLV',
    to: 'WBTC',
    toAssetId: 'WBTC-3FB5',
    provider: 'bitcoin.me',
    poolAddress: 'klv1qqqqqqqqqqqqqpgqkaye3972scltrwwruq4c7hyqmga468r6x04sq8482m',
    liquidityUsd: 77712,
    enabled: true,
  },
  {
    from: 'KLV',
    to: 'WETH',
    toAssetId: 'WETH-EFBC',
    provider: 'bitcoin.me',
    poolAddress: 'klv1qqqqqqqqqqqqqpgqwxtgqhkpc5zjpdt592gv95u73d3repz0x04sf4eh8f',
    liquidityUsd: 39157,
    enabled: true,
  },
  // ─── KLV ↔ Tokens Klever ecosystem ──────────────────────────────────────
  {
    from: 'KLV',
    to: 'KFI',
    toAssetId: 'KFI',
    provider: 'bitcoin.me',
    poolAddress: 'klv1qqqqqqqqqqqqqpgqfh7r4n30drqkzvw95teh9zdxkvkh8mhcx04s3cdxr4',
    liquidityUsd: 50308,
    enabled: true,
  },
  {
    from: 'KLV',
    to: 'DVK',
    toAssetId: 'DVK-34ZH',
    provider: 'bitcoin.me',
    poolAddress: 'klv1qqqqqqqqqqqqqpgqnx24fnedwagkzxjmdhgpx0c0kc9xdz7ex04skxj9g3',
    liquidityUsd: 23652,
    enabled: true,
  },
  // ─── Pares inversos (to → KLV) ───────────────────────────────────────────
  // Bitcoin.me soporta swap bidireccional en el mismo pool
  {
    from: 'USDT',
    fromAssetId: 'USDT-23V8',
    to: 'KLV',
    provider: 'bitcoin.me',
    poolAddress: 'klv1qqqqqqqqqqqqqpgqd9ds2tacasw7uc8q60wpm4qtn3kuswa2x04sz65vfc',
    liquidityUsd: 91240,
    enabled: true,
  },
  {
    from: 'KFI',
    fromAssetId: 'KFI',
    to: 'KLV',
    provider: 'bitcoin.me',
    poolAddress: 'klv1qqqqqqqqqqqqqpgqfh7r4n30drqkzvw95teh9zdxkvkh8mhcx04s3cdxr4',
    liquidityUsd: 50308,
    enabled: true,
  },
];

module.exports = {
  SWAP_PAIRS,
  REFERRAL_ADDRESS,
  REFERRAL_PERCENTAGE,
  BITCOIN_ME_REFERRAL_CONTRACT,
  BITCOIN_ME_ROUTER_CONTRACT,
};
