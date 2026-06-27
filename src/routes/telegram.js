// routes/telegram.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../db');

// ============================================================
// POST /api/telegram/link-code
// La app llama a esto para generar el código de vinculación.
// Body: { wallet_address: string }
// ============================================================
router.post('/link-code', async (req, res) => {
  try {
    const { wallet_address } = req.body;
    if (!wallet_address) {
      return res.status(400).json({ error: 'wallet_address required' });
    }

    const code = crypto.randomBytes(24).toString('hex');
    const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutos

    await pool.query(
      `INSERT INTO telegram_connections
         (wallet_address, link_code, link_code_expires_at, is_active)
       VALUES ($1, $2, $3, FALSE)
       ON CONFLICT (wallet_address)
       DO UPDATE SET
         link_code             = $2,
         link_code_expires_at  = $3,
         is_active             = FALSE,
         updated_at            = NOW()`,
      [wallet_address, code, expires]
    );

    res.json({
      code,
      deep_link: `https://t.me/DesnaIA_Bot?start=${code}`,
      expires_at: expires,
    });
  } catch (err) {
    console.error('[telegram/link-code]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// GET /api/telegram/status/:wallet_address
// La app consulta si la wallet ya está vinculada.
// ============================================================
router.get('/status/:wallet_address', async (req, res) => {
  try {
    const { wallet_address } = req.params;

    const result = await pool.query(
      `SELECT telegram_chat_id, telegram_username, linked_at, is_active
       FROM telegram_connections
       WHERE wallet_address = $1`,
      [wallet_address]
    );

    if (!result.rows.length || !result.rows[0].is_active) {
      return res.json({ linked: false });
    }

    const { telegram_username, linked_at } = result.rows[0];
    res.json({ linked: true, telegram_username, linked_at });
  } catch (err) {
    console.error('[telegram/status]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// DELETE /api/telegram/unlink/:wallet_address
// El usuario desvincula su Telegram desde la app.
// ============================================================
router.delete('/unlink/:wallet_address', async (req, res) => {
  try {
    const { wallet_address } = req.params;

    await pool.query(
      `UPDATE telegram_connections
       SET is_active  = FALSE,
           updated_at = NOW()
       WHERE wallet_address = $1`,
      [wallet_address]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[telegram/unlink]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// GET /api/telegram/preferences/:wallet_address
// La app carga las preferencias actuales del usuario.
// ============================================================
router.get('/preferences/:wallet_address', async (req, res) => {
  try {
    const { wallet_address } = req.params;

    const result = await pool.query(
      `SELECT
         price_change_enabled, price_change_pct,
         price_target_above, price_target_below,
         tx_received_enabled,
         rewards_summary,
         staking_expiry_enabled, staking_expiry_days,
         validator_jailed_enabled, validator_fee_change_enabled,
         epoch_summary_enabled,
         klever_news_enabled, market_offers_enabled
       FROM notification_preferences
       WHERE wallet_address = $1`,
      [wallet_address]
    );

    // Si no existen aún, devolver los defaults
    if (!result.rows.length) {
      return res.json({
        price_change_enabled: false,
        price_change_pct: 10.0,
        price_target_above: null,
        price_target_below: null,
        tx_received_enabled: true,
        rewards_summary: 'weekly',
        staking_expiry_enabled: true,
        staking_expiry_days: 3,
        validator_jailed_enabled: true,
        validator_fee_change_enabled: false,
        epoch_summary_enabled: false,
        klever_news_enabled: false,
        market_offers_enabled: false,
      });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[telegram/preferences GET]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// PUT /api/telegram/preferences/:wallet_address
// La app guarda los cambios de preferencias.
// Body: objeto parcial o completo de preferencias
// ============================================================
router.put('/preferences/:wallet_address', async (req, res) => {
  try {
    const { wallet_address } = req.params;

    const ALLOWED_FIELDS = [
      'price_change_enabled', 'price_change_pct',
      'price_target_above', 'price_target_below',
      'tx_received_enabled',
      'rewards_summary',
      'staking_expiry_enabled', 'staking_expiry_days',
      'validator_jailed_enabled', 'validator_fee_change_enabled',
      'epoch_summary_enabled',
      'klever_news_enabled', 'market_offers_enabled',
    ];

    // Filtrar solo campos permitidos
    const updates = {};
    for (const field of ALLOWED_FIELDS) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No valid fields provided' });
    }

    const fields = Object.keys(updates);
    const values = Object.values(updates);

    // Upsert
    await pool.query(
      `INSERT INTO notification_preferences (wallet_address, ${fields.join(', ')})
       VALUES ($1, ${fields.map((_, i) => `$${i + 2}`).join(', ')})
       ON CONFLICT (wallet_address)
       DO UPDATE SET
         ${fields.map((f, i) => `${f} = $${i + 2}`).join(', ')},
         updated_at = NOW()`,
      [wallet_address, ...values]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[telegram/preferences PUT]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
