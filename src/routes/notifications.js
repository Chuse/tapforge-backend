// routes/notifications.js
//
// Feed de la campana dentro de la app — distinto de routes/telegram.js
// (que gestiona el envío por Telegram y las preferencias). Este archivo solo
// lee/escribe sobre notification_log, que ahora tiene title/body/read_at
// además de las columnas originales de deduplicación.

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const { pool } = require('../db');

const KLV_ADDRESS_RE = /^klv1[023456789acdefghjklmnpqrstuvwxyz]{58}$/;

function isValidKleverAddress(addr) {
  return typeof addr === 'string' && KLV_ADDRESS_RE.test(addr);
}

// ─── Auth de admin — misma verificación que adminAuth.js /me ──────────────
// adminAuth.js no exporta un middleware reutilizable, así que replicamos
// exactamente su misma comprobación (token Bearer → sha256 → admin_sessions
// cruzado con admin_users, no revocada, no caducada, usuario habilitado) en
// vez de inventar un modelo de auth distinto para este archivo.
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice(7);
}

async function requireAdminAuth(req, res, next) {
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.role
       FROM admin_sessions s
       JOIN admin_users u ON u.id = s.user_id
       WHERE s.token_hash = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > NOW()
         AND u.enabled = true`,
      [sha256(token)]
    );

    if (!result.rows.length) {
      return res.status(401).json({ error: 'Sesión inválida o expirada' });
    }

    req.adminUser = result.rows[0];
    next();
  } catch (err) {
    console.error('[notifications/requireAdminAuth]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ============================================================
// GET /api/notifications/:wallet_address
// Feed completo (más reciente primero) + contador de no leídas.
// ============================================================
router.get('/:wallet_address', async (req, res) => {
  try {
    const { wallet_address } = req.params;
    if (!isValidKleverAddress(wallet_address)) {
      return res.status(400).json({ error: 'wallet_address inválida' });
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);

    const result = await pool.query(
      `SELECT id, alert_type, reference_id, title, body, sent_at, read_at
       FROM notification_log
       WHERE wallet_address = $1
       ORDER BY sent_at DESC
       LIMIT $2`,
      [wallet_address, limit]
    );

    const unreadResult = await pool.query(
      `SELECT COUNT(*) AS count
       FROM notification_log
       WHERE wallet_address = $1 AND read_at IS NULL`,
      [wallet_address]
    );

    res.json({
      items: result.rows,
      unread_count: parseInt(unreadResult.rows[0].count, 10),
    });
  } catch (err) {
    console.error('[notifications/list]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// PATCH /api/notifications/:id/read
// Marca una notificación concreta como leída.
// ============================================================
router.patch('/:id/read', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'id inválido' });
    }

    await pool.query(
      `UPDATE notification_log SET read_at = NOW() WHERE id = $1 AND read_at IS NULL`,
      [id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[notifications/read]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// PATCH /api/notifications/read-all/:wallet_address
// Marca todo el feed de una wallet como leído (botón "marcar todo").
// ============================================================
router.patch('/read-all/:wallet_address', async (req, res) => {
  try {
    const { wallet_address } = req.params;
    if (!isValidKleverAddress(wallet_address)) {
      return res.status(400).json({ error: 'wallet_address inválida' });
    }

    await pool.query(
      `UPDATE notification_log SET read_at = NOW() WHERE wallet_address = $1 AND read_at IS NULL`,
      [wallet_address]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[notifications/read-all]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// POST /api/notifications/broadcast   (SOLO ADMIN — requireAdminAuth)
// Inserta una notificación editorial para todas las wallets que tengan esa
// categoría activada en notification_preferences. Se materializa como una
// fila por wallet destinataria (notification_log no tiene concepto de "fila
// global", su deduplicación original es por wallet).
// Body: { alert_type, title, body, category_column }
// Header: Authorization: Bearer <token de sesión admin>
// ============================================================
const ALLOWED_CATEGORY_COLUMNS = [
  'klever_news_enabled', 'market_offers_enabled',
];

router.post('/broadcast', requireAdminAuth, async (req, res) => {
  try {
    const { alert_type, title, body, category_column } = req.body;

    if (!alert_type || !title || !body || !category_column) {
      return res.status(400).json({ error: 'alert_type, title, body y category_column son obligatorios' });
    }
    if (!ALLOWED_CATEGORY_COLUMNS.includes(category_column)) {
      return res.status(400).json({ error: `category_column debe ser una de: ${ALLOWED_CATEGORY_COLUMNS.join(', ')}` });
    }

    const recipients = await pool.query(
      `SELECT wallet_address FROM notification_preferences WHERE ${category_column} = TRUE`
    );

    if (recipients.rows.length === 0) {
      return res.json({ success: true, sent_to: 0 });
    }

    for (const row of recipients.rows) {
      await pool.query(
        `INSERT INTO notification_log (wallet_address, alert_type, title, body)
         VALUES ($1, $2, $3, $4)`,
        [row.wallet_address, alert_type, title, body]
      );
    }

    res.json({ success: true, sent_to: recipients.rows.length });
  } catch (err) {
    console.error('[notifications/broadcast]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
