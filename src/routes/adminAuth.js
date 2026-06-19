const express = require('express')
const crypto = require('crypto')
const bcrypt = require('bcryptjs')
const rateLimit = require('express-rate-limit')
const { pool } = require('../db')

const router = express.Router()

const SESSION_TTL_DAYS = Number(process.env.ADMIN_SESSION_TTL_DAYS || 7)

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
})

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function createSessionToken() {
  return crypto.randomBytes(32).toString('hex')
}

function getBearerToken(req) {
  const header = req.headers.authorization || ''
  if (!header.startsWith('Bearer ')) return null
  return header.slice(7)
}

async function auditLog(client, { userId, action, entityType, entityId, before, after, req }) {
  await client.query(
    `
    INSERT INTO admin_audit_log
      (user_id, action, entity_type, entity_id, before_json, after_json, ip, user_agent)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      userId || null,
      action,
      entityType,
      entityId || null,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      req.ip,
      req.headers['user-agent'] || null,
    ]
  )
}

router.post('/login', loginLimiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase()
  const password = String(req.body.password || '')

  if (!email || !password) {
    return res.status(400).json({ error: 'Email y password son obligatorios' })
  }

  const client = await pool.connect()

  try {
    const result = await client.query(
      `
      SELECT id, email, password_hash, name, role, enabled
      FROM admin_users
      WHERE email = $1
      `,
      [email]
    )

    const user = result.rows[0]

    if (!user || !user.enabled) {
      return res.status(401).json({ error: 'Credenciales no válidas' })
    }

    const ok = await bcrypt.compare(password, user.password_hash)

    if (!ok) {
      return res.status(401).json({ error: 'Credenciales no válidas' })
    }

    const token = createSessionToken()
    const tokenHash = sha256(token)
    const sessionId = crypto.randomUUID()

    await client.query('BEGIN')

    await client.query(
      `
      INSERT INTO admin_sessions
        (id, user_id, token_hash, ip, user_agent, expires_at)
      VALUES
        ($1, $2, $3, $4, $5, NOW() + ($6 || ' days')::interval)
      `,
      [
        sessionId,
        user.id,
        tokenHash,
        req.ip,
        req.headers['user-agent'] || null,
        SESSION_TTL_DAYS,
      ]
    )

    await client.query(
      `
      UPDATE admin_users
      SET last_login_at = NOW(), updated_at = NOW()
      WHERE id = $1
      `,
      [user.id]
    )

    await auditLog(client, {
      userId: user.id,
      action: 'admin.login',
      entityType: 'admin_user',
      entityId: String(user.id),
      before: null,
      after: { email: user.email, role: user.role },
      req,
    })

    await client.query('COMMIT')

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      expiresInDays: SESSION_TTL_DAYS,
    })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[adminAuth] login error:', e.message)
    res.status(500).json({ error: 'Error interno' })
  } finally {
    client.release()
  }
})

router.post('/logout', async (req, res) => {
  const token = getBearerToken(req)

  if (!token) {
    return res.json({ success: true })
  }

  try {
    await pool.query(
      `
      UPDATE admin_sessions
      SET revoked_at = NOW()
      WHERE token_hash = $1 AND revoked_at IS NULL
      `,
      [sha256(token)]
    )

    res.json({ success: true })
  } catch (e) {
    console.error('[adminAuth] logout error:', e.message)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.get('/me', async (req, res) => {
  const token = getBearerToken(req)

  if (!token) {
    return res.status(401).json({ error: 'No autorizado' })
  }

  try {
    const result = await pool.query(
      `
      SELECT
        u.id, u.email, u.name, u.role, u.enabled,
        s.id AS session_id,
        s.expires_at
      FROM admin_sessions s
      JOIN admin_users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > NOW()
        AND u.enabled = true
      `,
      [sha256(token)]
    )

    const row = result.rows[0]

    if (!row) {
      return res.status(401).json({ error: 'Sesión inválida o expirada' })
    }

    res.json({
      user: {
        id: row.id,
        email: row.email,
        name: row.name,
        role: row.role,
      },
      session: {
        id: row.session_id,
        expiresAt: row.expires_at,
      },
    })
  } catch (e) {
    console.error('[adminAuth] me error:', e.message)
    res.status(500).json({ error: 'Error interno' })
  }
})

module.exports = router
