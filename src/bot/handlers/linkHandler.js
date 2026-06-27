// bot/handlers/linkHandler.js
//
// Añadir a la inicialización del bot de Lyra:
//   const linkHandler = require('./handlers/linkHandler');
//   linkHandler.register(bot, pool);

const pool = require('../../db');

function register(bot) {

  // ============================================================
  // /start <code> — vinculación desde la app Desna
  // ============================================================
  bot.onText(/\/start (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const code = match[1].trim();

    try {
      const result = await pool.query(
        `SELECT wallet_address, link_code_expires_at
         FROM telegram_connections
         WHERE link_code = $1`,
        [code]
      );

      if (!result.rows.length) {
        return bot.sendMessage(
          chatId,
          '❌ *Código inválido*\n\nEste código no existe o ya fue usado.\nGenera uno nuevo desde la app Desna.',
          { parse_mode: 'Markdown' }
        );
      }

      const { wallet_address, link_code_expires_at } = result.rows[0];

      if (new Date() > new Date(link_code_expires_at)) {
        return bot.sendMessage(
          chatId,
          '⏱ *Código expirado*\n\nEl código solo es válido 10 minutos.\nGenera uno nuevo desde la app Desna.',
          { parse_mode: 'Markdown' }
        );
      }

      // Comprobar si este chat_id ya está vinculado a otra wallet
      const existing = await pool.query(
        `SELECT wallet_address FROM telegram_connections
         WHERE telegram_chat_id = $1 AND is_active = TRUE AND wallet_address != $2`,
        [chatId, wallet_address]
      );

      if (existing.rows.length) {
        // Desactivar la vinculación anterior
        await pool.query(
          `UPDATE telegram_connections
           SET is_active = FALSE, updated_at = NOW()
           WHERE telegram_chat_id = $1 AND wallet_address != $2`,
          [chatId, wallet_address]
        );
      }

      // Vincular
      await pool.query(
        `UPDATE telegram_connections
         SET telegram_chat_id      = $1,
             telegram_username     = $2,
             is_active             = TRUE,
             link_code             = NULL,
             link_code_expires_at  = NULL,
             linked_at             = NOW(),
             updated_at            = NOW()
         WHERE wallet_address = $3`,
        [chatId, msg.chat.username || null, wallet_address]
      );

      // Crear preferencias por defecto si no existen
      await pool.query(
        `INSERT INTO notification_preferences (wallet_address)
         VALUES ($1)
         ON CONFLICT DO NOTHING`,
        [wallet_address]
      );

      const shortWallet = `${wallet_address.slice(0, 8)}...${wallet_address.slice(-6)}`;

      await bot.sendMessage(
        chatId,
        `✅ *Wallet vinculada*\n\n` +
        `\`${shortWallet}\` ya está conectada a este chat.\n\n` +
        `Desde la app Desna puedes configurar qué alertas quieres recibir aquí:\n\n` +
        `• 💸 Transacciones recibidas\n` +
        `• 📊 Alertas de precio\n` +
        `• ⏳ Vencimiento de delegaciones\n` +
        `• 🚨 Cambios en validadores\n` +
        `• 🎁 Resumen de rewards`,
        { parse_mode: 'Markdown' }
      );

    } catch (err) {
      console.error('[linkHandler /start]', err);
      bot.sendMessage(chatId, '❌ Error interno. Inténtalo de nuevo en unos minutos.');
    }
  });

  // ============================================================
  // /start sin código — bienvenida normal
  // ============================================================
  bot.onText(/\/start$/, async (msg) => {
    const chatId = msg.chat.id;

    // Comprobar si ya está vinculado
    const result = await pool.query(
      `SELECT tc.wallet_address
       FROM telegram_connections tc
       WHERE tc.telegram_chat_id = $1 AND tc.is_active = TRUE`,
      [chatId]
    );

    if (result.rows.length) {
      const shortWallet = (() => {
        const w = result.rows[0].wallet_address;
        return `${w.slice(0, 8)}...${w.slice(-6)}`;
      })();

      return bot.sendMessage(
        chatId,
        `👋 *Hola de nuevo*\n\n` +
        `Tu wallet \`${shortWallet}\` ya está vinculada.\n\n` +
        `Gestiona tus alertas desde la app Desna.`,
        { parse_mode: 'Markdown' }
      );
    }

    bot.sendMessage(
      chatId,
      `👋 *Bienvenido a Lyra*\n\n` +
      `Lyra es el asistente de notificaciones de *Desna Wallet*.\n\n` +
      `Para empezar, abre la app Desna y ve a\n` +
      `*Ajustes → Notificaciones → Conectar Telegram*`,
      { parse_mode: 'Markdown' }
    );
  });

  // ============================================================
  // /desvincular — el usuario puede desvincularse desde el bot
  // ============================================================
  bot.onText(/\/desvincular/, async (msg) => {
    const chatId = msg.chat.id;

    try {
      const result = await pool.query(
        `UPDATE telegram_connections
         SET is_active = FALSE, updated_at = NOW()
         WHERE telegram_chat_id = $1 AND is_active = TRUE
         RETURNING wallet_address`,
        [chatId]
      );

      if (!result.rows.length) {
        return bot.sendMessage(chatId, 'No tienes ninguna wallet vinculada.');
      }

      bot.sendMessage(
        chatId,
        `✅ Wallet desvinculada correctamente.\n\nYa no recibirás alertas aquí.`
      );
    } catch (err) {
      console.error('[linkHandler /desvincular]', err);
      bot.sendMessage(chatId, '❌ Error interno. Inténtalo de nuevo.');
    }
  });
}

module.exports = { register };
