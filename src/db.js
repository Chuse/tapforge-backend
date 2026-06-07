/**
 * db.js
 * Conexión a PostgreSQL via Railway DATABASE_URL
 * y creación de tablas si no existen.
 */

const { Pool } = require('pg')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
})

async function initDB() {
  const client = await pool.connect()
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS chains (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        symbol      TEXT NOT NULL,
        enabled     BOOLEAN DEFAULT false,
        position    INTEGER DEFAULT 99,
        rpc         TEXT,
        explorer    TEXT,
        created_at  TIMESTAMP DEFAULT NOW(),
        updated_at  TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS tokens (
        id          TEXT NOT NULL,
        chain_id    TEXT NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        symbol      TEXT NOT NULL,
        precision   INTEGER DEFAULT 6,
        featured    BOOLEAN DEFAULT false,
        logo        TEXT,
        synced_at   TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (id, chain_id)
      );
    `)

    // Insertar chains base si no existen
    await client.query(`
      INSERT INTO chains (id, name, symbol, enabled, position, rpc, explorer)
      VALUES
        ('klever',   'Klever Blockchain', 'KLV', true,  1, 'https://node.mainnet.klever.org',   'https://kleverscan.org'),
        ('tron',     'Tron',              'TRX', false, 2, 'https://api.trongrid.io',            'https://tronscan.org'),
        ('ethereum', 'Ethereum',          'ETH', false, 3, null,                                 'https://etherscan.io'),
        ('bitcoin',  'Bitcoin',           'BTC', false, 4, null,                                 'https://blockstream.info')
      ON CONFLICT (id) DO NOTHING;
    `)

    // Insertar tokens base de Klever si no existen
    await client.query(`
      INSERT INTO tokens (id, chain_id, name, symbol, precision, featured, logo)
      VALUES
        ('KLV',        'klever', 'Klever',         'KLV',   6, true,  null),
        ('KFI',        'klever', 'Klever Finance',  'KFI',   6, true,  null),
        ('DVK-34ZH',   'klever', 'Duovek',          'DVK',   6, false, null),
        ('KUNAI-18TK', 'klever', 'Kunai',           'KUNAI', 6, false, null),
        ('USDT-23V8',  'klever', 'Tether USD',      'USDT',  6, false, null),
        ('TRX',        'tron',   'Tron',             'TRX',   6, true,  null),
        ('USDT-TRC20', 'tron',   'Tether USD',      'USDT',  6, true,  null)
      ON CONFLICT (id, chain_id) DO NOTHING;
    `)

    console.log('[db] Base de datos inicializada correctamente')
  } finally {
    client.release()
  }
}

module.exports = { pool, initDB }
