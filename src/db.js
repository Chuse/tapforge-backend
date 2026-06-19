/**
 * db.js
 * PostgreSQL Railway + tablas base Desna/TapForge
 */

const { Pool } = require('pg')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false,
})

async function initDB() {
  const client = await pool.connect()

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS chains (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        display_name TEXT,
        symbol TEXT NOT NULL,
        enabled BOOLEAN DEFAULT false,
        position INTEGER DEFAULT 99,
        rpc TEXT,
        explorer TEXT,
        logo TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS tokens (
        id TEXT NOT NULL,
        chain_id TEXT NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        symbol TEXT NOT NULL,
        precision INTEGER DEFAULT 6,
        featured BOOLEAN DEFAULT false,
        logo TEXT,
        synced_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (id, chain_id)
      );
    `)

    await client.query(`
      ALTER TABLE chains ADD COLUMN IF NOT EXISTS display_name TEXT;
      ALTER TABLE chains ADD COLUMN IF NOT EXISTS logo TEXT;
    `)

    await client.query(`
      INSERT INTO chains
        (id, name, display_name, symbol, enabled, position, rpc, explorer, logo)
      VALUES
        ('klever',   'Klever Blockchain', 'Klever Blockchain', 'KLV', true,  1, 'https://node.mainnet.klever.org', 'https://kleverscan.org', null),
        ('tron',     'Tron',              'Tron',              'TRX', false, 2, 'https://api.trongrid.io',          'https://tronscan.org',  null),
        ('ethereum', 'Ethereum',          'Ethereum',          'ETH', false, 3, null,                              'https://etherscan.io',  null),
        ('bitcoin',  'Bitcoin',           'Bitcoin',           'BTC', false, 4, null,                              'https://blockstream.info', null),
        ('base',     'Base',              'Base',              'ETH', false, 5, 'https://mainnet.base.org',        'https://basescan.org',  null)
      ON CONFLICT (id) DO UPDATE SET
        display_name = COALESCE(chains.display_name, EXCLUDED.display_name),
        logo = COALESCE(chains.logo, EXCLUDED.logo),
        updated_at = NOW();
    `)

    await client.query(`
      INSERT INTO tokens
        (id, chain_id, name, symbol, precision, featured, logo)
      VALUES
        ('KLV',        'klever', 'Klever',         'KLV',   6, true,  null),
        ('KFI',        'klever', 'Klever Finance', 'KFI',   6, true,  null),
        ('DVK-34ZH',   'klever', 'Duovek',         'DVK',   6, false, null),
        ('KUNAI-18TK', 'klever', 'Kunai',          'KUNAI', 6, false, null),
        ('USDT-23V8',  'klever', 'Tether USD',     'USDT',  6, false, null),
        ('TRX',        'tron',   'Tron',           'TRX',   6, true,  null),
        ('USDT-TRC20', 'tron',   'Tether USD',     'USDT',  6, true,  null)
      ON CONFLICT (id, chain_id) DO NOTHING;
    `)

    console.log('[db] Base de datos inicializada correctamente')
  } finally {
    client.release()
  }
}

module.exports = {
  pool,
  initDB,
}
