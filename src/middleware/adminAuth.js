const crypto = require('crypto')
const { pool } = require('../db')

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function getBearerToken(req) {
  const header = req.headers.authorization || ''
  if (!header.startsWith('Bearer ')) return null
  return header.slice(7)
}

async function loadAdminUser(req, res, next) {
  const token = getBearerToken(req)

  if (!token) {
    return res.status(401).json({ error: 'No autorizado' })
  }

  try {
    const result = await pool.query(
      `
      SELECT
        u.id,
        u.email,
        u.name,
        u.role,
        u.enabled,
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

    req.admin = {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      sessionId: row.session_id,
    }

    next()
  } catch (e) {
    console.error('[adminAuth middleware] error:', e.message)
    res.status(500).json({ error: 'Error interno' })
  }
}

function requireAdmin(req, res, next) {
  return loadAdminUser(req, res, () => {
    if (!['owner', 'admin'].includes(req.admin.role)) {
      return res.status(403).json({ error: 'Permisos insuficientes' })
    }

    next()
  })
}

function requireOwner(req, res, next) {
  return loadAdminUser(req, res, () => {
    if (req.admin.role !== 'owner') {
      return res.status(403).json({ error: 'Solo owner puede realizar esta acción' })
    }

    next()
  })
}

function requireViewer(req, res, next) {
  return loadAdminUser(req, res, next)
}

module.exports = {
  loadAdminUser,
  requireAdmin,
  requireOwner,
  requireViewer,
}
