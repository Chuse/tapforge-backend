/**
 * db.js
 * PostgreSQL Railway + tablas base Desna/TapForge + infraestructura admin
 */

const { Pool } = require('pg')
const bcrypt = require('bcryptjs')

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

      CREATE TABLE IF NOT EXISTS admin_users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT,
        role TEXT NOT NULL DEFAULT 'admin',
        enabled BOOLEAN DEFAULT true,
        last_login_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS admin_sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL,
        ip TEXT,
        user_agent TEXT,
        expires_at TIMESTAMP NOT NULL,
        revoked_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        before_json JSONB,
        after_json JSONB,
        ip TEXT,
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `)

    await client.query(`
      ALTER TABLE chains ADD COLUMN IF NOT EXISTS display_name TEXT;
      ALTER TABLE chains ADD COLUMN IF NOT EXISTS logo TEXT;

      -- notification_log nació solo para deduplicar alertas de Telegram
      -- (wallet_address + alert_type + reference_id). Le añadimos contenido
      -- real para que también pueda alimentar la campana dentro de la app.
      ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS title   TEXT;
      ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS body    TEXT;
      ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS read_at TIMESTAMP;

      ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS name TEXT;
      ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'admin';
      ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT true;
      ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP;
      ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

      CREATE INDEX IF NOT EXISTS idx_notification_log_wallet_sent
        ON notification_log (wallet_address, sent_at DESC);
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

    await createInitialAdmin(client)

    console.log('[db] Base de datos inicializada correctamente')
  } finally {
    client.release()
  }
}

async function createInitialAdmin(client) {
  const email = process.env.ADMIN_EMAIL
  const password = process.env.ADMIN_PASSWORD

  if (!email || !password) {
    console.log('[db] ADMIN_EMAIL / ADMIN_PASSWORD no definidos. No se crea admin inicial.')
    return
  }

  const existing = await client.query(
    'SELECT id FROM admin_users WHERE email = $1',
    [email.toLowerCase()]
  )

  if (existing.rows.length > 0) {
    return
  }

  const passwordHash = await bcrypt.hash(password, 12)

  await client.query(
    `
    INSERT INTO admin_users
      (email, password_hash, name, role, enabled)
    VALUES
      ($1, $2, $3, 'owner', true)
    `,
    [
      email.toLowerCase(),
      passwordHash,
      'Administrador',
    ]
  )

  console.log('[db] Admin inicial creado:', email)
}

module.exports = {
  pool,
  initDB,
}
