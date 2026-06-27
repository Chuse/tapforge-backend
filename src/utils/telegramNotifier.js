// utils/telegramNotifier.js
//
// Uso:
//   const { sendAlert, hasAlertBeenSent } = require('./telegramNotifier');
//   await sendAlert(wallet_address, 'tx_received', message, { reference_id: txHash });

const pool = require('../db');

// Importar el bot singleton (asumiendo que ya existe en el proyecto)
// Si el bot se inicializa en otro archivo, importarlo desde ahí.
const TelegramBot = require('node-telegram-bot-api');
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);

// ============================================================
// Comprueba si ya se envió esta alerta recientemente.
// Evita duplicados en caso de que el cron corra varias veces.
// windowMinutes: cuántos minutos hacia atrás mirar
// ============================================================
async function hasAlertBeenSent(wallet_address, alert_type, reference_id, windowMinutes = 60) {
  const result = await pool.query(
    `SELECT id FROM notification_log
     WHERE wallet_address = $1
       AND alert_type     = $2
       AND reference_id   = $3
       AND sent_at        > NOW() - INTERVAL '${windowMinutes} minutes'
     LIMIT 1`,
    [wallet_address, alert_type, reference_id]
  );
  return result.rows.length > 0;
}

// ============================================================
// Registra una alerta en el log para evitar reenvíos.
// ============================================================
async function logAlert(wallet_address, alert_type, reference_id) {
  await pool.query(
    `INSERT INTO notification_log (wallet_address, alert_type, reference_id)
     VALUES ($1, $2, $3)`,
    [wallet_address, alert_type, reference_id || null]
  );
}

// ============================================================
// Envía un mensaje de Telegram a la wallet indicada.
// Comprueba automáticamente que esté vinculada y activa.
//
// options:
//   reference_id  — para dedup en notification_log (ej. txHash)
//   check_dedup   — si true, no envía si ya está en el log
//   dedup_window  — minutos hacia atrás para comprobar dedup (default 60)
//   parse_mode    — 'Markdown' | 'HTML' (default Markdown)
// ============================================================
async function sendAlert(wallet_address, alert_type, message, options = {}) {
  const {
    reference_id = null,
    check_dedup = true,
    dedup_window = 60,
    parse_mode = 'Markdown',
  } = options;

  try {
    // 1. Comprobar dedup
    if (check_dedup && reference_id) {
      const already = await hasAlertBeenSent(wallet_address, alert_type, reference_id, dedup_window);
      if (already) return { sent: false, reason: 'duplicate' };
    }

    // 2. Obtener chat_id
    const result = await pool.query(
      `SELECT telegram_chat_id
       FROM telegram_connections
       WHERE wallet_address = $1 AND is_active = TRUE`,
      [wallet_address]
    );

    if (!result.rows.length) {
      return { sent: false, reason: 'not_linked' };
    }

    const { telegram_chat_id } = result.rows[0];

    // 3. Comprobar preferencia para este tipo de alerta
    const prefResult = await pool.query(
      `SELECT ${PREF_FIELD_FOR[alert_type] || 'TRUE as enabled'}
       FROM notification_preferences
       WHERE wallet_address = $1`,
      [wallet_address]
    );

    if (prefResult.rows.length) {
      const prefField = PREF_FIELD_FOR[alert_type];
      if (prefField && prefResult.rows[0][prefField] === false) {
        return { sent: false, reason: 'disabled_by_user' };
      }
    }

    // 4. Enviar
    await bot.sendMessage(telegram_chat_id, message, { parse_mode });

    // 5. Loguear
    if (reference_id) {
      await logAlert(wallet_address, alert_type, reference_id);
    }

    return { sent: true };

  } catch (err) {
    // Si el usuario bloqueó el bot, desactivar la conexión
    if (err?.response?.body?.error_code === 403) {
      await pool.query(
        `UPDATE telegram_connections
         SET is_active = FALSE, updated_at = NOW()
         WHERE wallet_address = $1`,
        [wallet_address]
      );
      return { sent: false, reason: 'bot_blocked' };
    }

    console.error(`[telegramNotifier] Error sending to ${wallet_address}:`, err.message);
    return { sent: false, reason: 'error', error: err.message };
  }
}

// ============================================================
// Mapa de alert_type → campo de preferencia en la tabla
// ============================================================
const PREF_FIELD_FOR = {
  tx_received:          'tx_received_enabled',
  price_change:         'price_change_enabled',
  price_target:         'price_change_enabled',
  staking_expiry:       'staking_expiry_enabled',
  rewards_summary:      null,                        // se controla por rewards_summary !== 'off'
  validator_jailed:     'validator_jailed_enabled',
  validator_fee_change: 'validator_fee_change_enabled',
  epoch_summary:        'epoch_summary_enabled',
  klever_news:          'klever_news_enabled',
  market_offer:         'market_offers_enabled',
};

// ============================================================
// Helpers de formato para los mensajes
// ============================================================
const fmt = {
  wallet: (addr) => `\`${addr.slice(0, 8)}...${addr.slice(-6)}\``,
  amount: (n, ticker) => `*${Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 })} ${ticker}*`,
  pct: (n) => `${n > 0 ? '+' : ''}${Number(n).toFixed(2)}%`,
};

// ============================================================
// Plantillas de mensajes listos para usar
// ============================================================
const templates = {
  txReceived: ({ wallet, amount, ticker, txHash }) =>
    `💸 *Transacción recibida*\n\n` +
    `Wallet: ${fmt.wallet(wallet)}\n` +
    `Importe: ${fmt.amount(amount, ticker)}\n` +
    `Hash: \`${txHash.slice(0, 16)}...\``,

  priceChange: ({ ticker, price, change }) =>
    `📊 *Alerta de precio — ${ticker}*\n\n` +
    `Precio actual: *$${price}*\n` +
    `Variación 24h: ${fmt.pct(change)}`,

  stakingExpiry: ({ wallet, validator, daysLeft }) =>
    `⏳ *Delegación próxima a vencer*\n\n` +
    `Wallet: ${fmt.wallet(wallet)}\n` +
    `Validador: \`${validator}\`\n` +
    `Vence en: *${daysLeft} día${daysLeft !== 1 ? 's' : ''}*`,

  validatorJailed: ({ validator, frozenKlv }) =>
    `🚨 *Validador jailed*\n\n` +
    `\`${validator}\`\n` +
    `KLV congelado: ${fmt.amount(frozenKlv, 'KLV')}\n\n` +
    `Revisa tu delegación en Desna Wallet.`,

  rewardsSummary: ({ wallet, totalRewards, ticker, period }) =>
    `🎁 *Resumen de rewards — ${period}*\n\n` +
    `Wallet: ${fmt.wallet(wallet)}\n` +
    `Rewards acumulados: ${fmt.amount(totalRewards, ticker)}`,
};

module.exports = { sendAlert, hasAlertBeenSent, logAlert, templates, fmt };
