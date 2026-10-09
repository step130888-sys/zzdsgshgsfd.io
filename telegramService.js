const fs = require('fs');
const path = require('path');
const db = require('./db');
const gdriveService = require('./gdriveService');

const CONFIG_PATH = path.join(__dirname, 'bot_config.json');

function getConfig() {
  const defaults = {
    bot_token: '8837250732:AAGS9Z_PoAuJQdQbDyFJ5us1ny1CmHSs0mc',
    bot_username: 'ping_sstu_bot',
    leadership_group_chat_id: null,
    api_base_url: 'https://api.telegram.org',
    proxy_url: ''
  };
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return Object.assign(defaults, data);
    } catch (e) {
      console.error('Error reading bot_config.json:', e);
    }
  }
  return defaults;
}

function saveConfig(updates) {
  const current = getConfig();
  Object.assign(current, updates);
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving bot_config.json:', e);
  }
}

function getBotToken() {
  return process.env.TELEGRAM_BOT_TOKEN || getConfig().bot_token;
}

function getBotUsername() {
  return getConfig().bot_username || 'ping_sstu_bot';
}

function getLeadershipChatId() {
  return getConfig().leadership_group_chat_id;
}

let cachedAgent = null;
let cachedProxy = null;

function getProxyDispatcher() {
  const cfg = getConfig();
  const proxy = (cfg.proxy_url || process.env.TELEGRAM_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '').trim();
  if (!proxy) return null;
  if (proxy === cachedProxy && cachedAgent) return cachedAgent;
  try {
    const { ProxyAgent } = require('undici');
    cachedAgent = new ProxyAgent(proxy);
    cachedProxy = proxy;
    return cachedAgent;
  } catch (e) {
    console.error('[TelegramBot] Failed to initialize ProxyAgent:', e.message);
    return null;
  }
}

async function callTelegramApi(method, body = {}, timeoutMs = 25000) {
  const token = getBotToken();
  if (!token) return null;
  const cfg = getConfig();
  const baseUrl = (cfg.api_base_url || 'https://api.telegram.org').trim().replace(/\/+$/, '');
  const url = `${baseUrl}/bot${token}/${method}`;

  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  };

  const dispatcher = getProxyDispatcher();
  if (dispatcher) {
    options.dispatcher = dispatcher;
  }

  try {
    const res = await fetch(url, options);
    return await res.json();
  } catch (err) {
    if (method !== 'getUpdates') {
      console.error(`Telegram API error on ${method}:`, err.message);
    }
    return null;
  }
}

function getMainReplyKeyboard(user = null) {
  const isManager = user && user.access_level >= 2;
  const keyboard = [];

  if (user) {
    keyboard.push([
      { text: '📋 Мои задачи' },
      { text: '🔥 Горящие дедлайны' }
    ]);

    keyboard.push([
      { text: '🟢 Свободные задачи' }
    ]);

    if (isManager) {
      keyboard.push([
        { text: '📋 Задачи на проверке' },
        { text: '📊 Статистика медиацентра' }
      ]);
    }

    keyboard.push([
      { text: '👤 Мой профиль' },
      { text: 'ℹ️ Помощь' }
    ]);
  } else {
    keyboard.push([
      { text: '🟢 Свободные задачи' }
    ]);
    keyboard.push([
      { text: '👤 Мой профиль' },
      { text: 'ℹ️ Помощь' }
    ]);
  }

  return {
    keyboard,
    resize_keyboard: true,
    is_persistent: true
  };
}

async function sendTelegramMessage(chatId, text, replyMarkup = null) {
  if (!chatId) return false;
  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML'
  };

  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  } else if (!String(chatId).startsWith('-')) {
    try {
      const user = await db.get('SELECT * FROM users WHERE telegram_id = ?', [String(chatId)]);
      body.reply_markup = getMainReplyKeyboard(user);
    } catch (e) {
      body.reply_markup = getMainReplyKeyboard(null);
    }
  }

  const res = await callTelegramApi('sendMessage', body);
  return Boolean(res && res.ok);
}

async function testTelegramConnection() {
  const token = getBotToken();
  if (!token) {
    return { ok: false, error: 'Токен бота не настроен в bot_config.json' };
  }
  const cfg = getConfig();
  const baseUrl = (cfg.api_base_url || 'https://api.telegram.org').trim().replace(/\/+$/, '');
  const url = `${baseUrl}/bot${token}/getMe`;

  const options = {
    method: 'GET',
    signal: AbortSignal.timeout(8000)
  };
  const dispatcher = getProxyDispatcher();
  if (dispatcher) {
    options.dispatcher = dispatcher;
  }

  try {
    const res = await fetch(url, options);
    const data = await res.json();
    if (data && data.ok) {
      return { ok: true, bot: data.result, baseUrl, proxy: cfg.proxy_url || null };
    } else {
      return { ok: false, error: data?.description || 'Неизвестная ошибка Telegram API', baseUrl, proxy: cfg.proxy_url || null };
    }
  } catch (err) {
    return {
      ok: false,
      error: `Ошибка соединения: ${err.message}. (api.telegram.org недоступен напрямую с вашего провайдера).`,
      baseUrl,
      proxy: cfg.proxy_url || null,
      isNetworkError: true
    };
  }
}

async function editTelegramMessage(chatId, messageId, text, replyMarkup = null) {
  if (!chatId || !messageId) return false;
  const body = {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    parse_mode: 'HTML'
  };
  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }
  const res = await callTelegramApi('editMessageText', body);
  return Boolean(res && res.ok);
}

async function answerCallbackQuery(callbackQueryId, text = null, showAlert = false) {
  if (!callbackQueryId) return false;
  const body = {
    callback_query_id: callbackQueryId,
    show_alert: showAlert
  };
  if (text) {
    body.text = text;
  }
  const res = await callTelegramApi('answerCallbackQuery', body);
  return Boolean(res && res.ok);
}

function getRatingKeyboard(taskId, fileLink = null) {
  const gdriveFolderUrl = gdriveService.getTargetFolderUrl();
  const inline_keyboard = [
    [
      { text: '🌟 10', callback_data: `rate:${taskId}:10` },
      { text: '9', callback_data: `rate:${taskId}:9` },
      { text: '8', callback_data: `rate:${taskId}:8` },
      { text: '7', callback_data: `rate:${taskId}:7` }
    ],
    [
      { text: '6', callback_data: `rate:${taskId}:6` },
      { text: '5', callback_data: `rate:${taskId}:5` },
      { text: '4', callback_data: `rate:${taskId}:4` },
      { text: '3', callback_data: `rate:${taskId}:3` }
    ],
    [
      { text: '📁 Папка сдачи (Google Диск) ↗', url: gdriveFolderUrl }
    ]
  ];

  if (fileLink && fileLink.startsWith('https://') && !fileLink.includes('localhost') && !fileLink.includes('127.0.0.1')) {
    inline_keyboard[2].unshift({ text: '📂 Открыть файл ↗', url: fileLink });
  }

  inline_keyboard.push([
    { text: '🔄 На доработку', callback_data: `rework:${taskId}` }
  ]);

  return { inline_keyboard };
}

async function applyTaskRatingByTgUser(taskId, score, tgUserId, tgUsername) {
  const task = await db.get('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!task) {
    return { success: false, message: `❌ Задача #${taskId} не найдена в системе.` };
  }

  if (task.status === 'done' && task.score !== null) {
    return { success: false, message: `ℹ️ Задача #${task.id} уже проверена и закрыта с оценкой ${task.score}/10.`, task };
  }

  // Find reviewer by telegram_id or username
  let grader = await db.get('SELECT * FROM users WHERE telegram_id = ?', [String(tgUserId)]);
  if (!grader && tgUsername) {
    const cleanUser = tgUsername.replace('@', '').toLowerCase();
    grader = await db.get(
      'SELECT * FROM users WHERE telegram_id LIKE ? OR telegram_id LIKE ? OR LOWER(username) = ?',
      [`%${cleanUser}%`, cleanUser, cleanUser]
    );
    if (grader) {
      grader.telegram_id = String(tgUserId);
      await db.run('UPDATE users SET telegram_id = ? WHERE id = ?', [String(tgUserId), grader.id]);
    }
  }

  if (!grader) {
    return {
      success: false,
      message: '⚠️ Ваш Telegram не привязан к аккаунту руководителя на сайте.\nНапишите боту: /bind <логин> <пароль> или нажмите «Привязать мой Telegram» в панели руководства.',
      task
    };
  }

  const isMgmt = grader.access_level >= 3;
  const isHeadOfDept = grader.access_level === 2 && grader.role === task.direction;

  if (!isMgmt && !isHeadOfDept) {
    return {
      success: false,
      message: `⛔ Недостаточно прав для оценки задачи #${task.id}.\nВаш профиль: ${grader.name} (${grader.role}, Ур. ${grader.access_level}). Оценивать могут руководители (3–4 ур.) или глава цеха '${task.direction}'.`,
      task,
      grader
    };
  }

  if (score < 1 || score > 10) {
    return { success: false, message: 'Оценка должна быть целым числом в диапазоне от 1 до 10.', task, grader };
  }

  await db.run(
    'UPDATE tasks SET score = ?, graded_by_id = ?, status = "done" WHERE id = ?',
    [score, grader.id, task.id]
  );
  task.score = score;
  task.graded_by_id = grader.id;
  task.status = 'done';

  await db.recalculateUserStats(task.assigned_to_id);

  try {
    await notifyTaskGraded(task, grader, score);
  } catch (e) {
    console.error('Error notifying assignee about grade:', e);
  }

  let assigneeName = 'Исполнитель';
  if (task.assigned_to_id) {
    const assignee = await db.get('SELECT name FROM users WHERE id = ?', [task.assigned_to_id]);
    if (assignee) assigneeName = assignee.name;
  }

  return {
    success: true,
    message: `✅ Задача #${task.id} успешно принята с оценкой ${score}/10! Рейтинг ${assigneeName} пересчитан.`,
    task,
    grader
  };
}

async function applyTaskReworkByTgUser(taskId, tgUserId, tgUsername, notes) {
  const task = await db.get('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!task) {
    return { success: false, message: `❌ Задача #${taskId} не найдена в системе.` };
  }

  let grader = await db.get('SELECT * FROM users WHERE telegram_id = ?', [String(tgUserId)]);
  if (!grader && tgUsername) {
    const cleanUser = tgUsername.replace('@', '').toLowerCase();
    grader = await db.get(
      'SELECT * FROM users WHERE telegram_id LIKE ? OR telegram_id LIKE ? OR LOWER(username) = ?',
      [`%${cleanUser}%`, cleanUser, cleanUser]
    );
    if (grader) {
      grader.telegram_id = String(tgUserId);
      await db.run('UPDATE users SET telegram_id = ? WHERE id = ?', [String(tgUserId), grader.id]);
    }
  }

  if (!grader) {
    return {
      success: false,
      message: '⚠️ Ваш Telegram не привязан к аккаунту руководителя на сайте.\nНапишите боту: /bind <логин> <пароль>',
      task
    };
  }

  if (grader.access_level < 2) {
    return {
      success: false,
      message: `⛔ Недостаточно прав для отправки задачи #${task.id} на доработку.\nВаш профиль: ${grader.name} (${grader.role}, Ур. ${grader.access_level}).`,
      task,
      grader
    };
  }

  if (grader.access_level === 2 && grader.role !== task.direction && grader.role !== 'Руководство') {
    return {
      success: false,
      message: `⛔ Как глава цеха '${grader.role}', вы можете отправлять на доработку только задачи своего цеха (задача #${task.id} относится к '${task.direction}').`,
      task,
      grader
    };
  }

  const reworkNotes = notes && notes.trim() ? notes.trim() : 'Возвращено на доработку через Telegram';
  await db.run(
    'UPDATE tasks SET status = "rework", score = NULL, graded_by_id = NULL, rework_notes = ? WHERE id = ?',
    [reworkNotes, task.id]
  );
  task.status = 'rework';
  task.score = null;
  task.graded_by_id = null;
  task.rework_notes = reworkNotes;

  await db.recalculateUserStats(task.assigned_to_id);

  try {
    await notifyTaskRework(task, grader, reworkNotes);
  } catch (e) {
    console.error('Error notifying assignee about rework:', e);
  }

  return {
    success: true,
    message: `🔄 Задача #${task.id} отправлена на доработку.`,
    task,
    grader
  };
}

// Outgoing notification helpers
async function notifyTaskSubmittedForReview(task, user) {
  const gdriveFolderUrl = gdriveService.getTargetFolderUrl();
  const fileBadge = task.file_name ? `📎 <b>Файл:</b> <code>${task.file_name}</code>\n` : '';
  const fileLinkLine = task.file_link ? `🔗 <b>Ссылка / файл:</b> ${task.file_link}\n` : '';
  const deadlineBadge = task.deadline ? `⏰ <b>Дедлайн:</b> <code>${task.deadline.replace('T', ' ')}</code>\n` : '';

  const card = (
    '📬 <b>НОВАЯ РАБОТА НА ПРОВЕРКУ!</b>\n\n' +
    `📌 <b>Задача:</b> #${task.id} — <b>${task.title}</b>\n` +
    `📂 <b>Цех:</b> <code>${task.direction}</code>\n` +
    `👤 <b>Исполнитель:</b> ${user.name} (@${user.username || 'user_' + user.id})\n` +
    deadlineBadge +
    fileBadge +
    fileLinkLine +
    `📁 <b>Google Диск команды:</b> <a href="${gdriveFolderUrl}">Открыть папку сдачи</a>\n\n` +
    '⭐ <b>Поставьте оценку прямо здесь (1–10) или отправьте на доработку:</b>'
  );

  const kbd = getRatingKeyboard(task.id, task.file_link);
  let sentCount = 0;

  // Send to leadership group chat
  const leadGroup = getLeadershipChatId();
  if (leadGroup) {
    const ok = await sendTelegramMessage(leadGroup, card, kbd);
    if (ok) sentCount++;
  }

  // Send to individual managers (level >= 3)
  const managers = await db.all(
    'SELECT telegram_id FROM users WHERE access_level >= 3 AND telegram_id IS NOT NULL AND is_approved = 1'
  );
  for (const m of managers) {
    if (m.telegram_id && m.telegram_id !== leadGroup) {
      const ok = await sendTelegramMessage(m.telegram_id, card, kbd);
      if (ok) sentCount++;
    }
  }

  return sentCount;
}

async function notifyNewUserRegistered(newUser) {
  const card = (
    '🆕 <b>НОВАЯ ЗАЯВКА НА РЕГИСТРАЦИЮ!</b>\n\n' +
    `👤 <b>ФИО:</b> ${newUser.name}\n` +
    `🔑 <b>Логин:</b> <code>@${newUser.username}</code>\n` +
    `🏷️ <b>Цех / Направление:</b> <b>${newUser.role}</b>\n` +
    `✈️ <b>Telegram:</b> ${newUser.telegram_id || 'не указан'}\n\n` +
    '👑 <i>Главный администратор (4 ур.) может одобрить заявку в панели «Управление профилями».</i>'
  );

  const admins = await db.all(
    'SELECT telegram_id FROM users WHERE access_level = 4 AND telegram_id IS NOT NULL'
  );
  let sentCount = 0;
  for (const a of admins) {
    if (a.telegram_id) {
      const ok = await sendTelegramMessage(a.telegram_id, card);
      if (ok) sentCount++;
    }
  }
  return sentCount;
}

async function notifyTaskGraded(task, reviewer, score) {
  if (!task.assigned_to_id) return false;
  const assignee = await db.get('SELECT * FROM users WHERE id = ?', [task.assigned_to_id]);
  if (!assignee || !assignee.telegram_id) return false;

  const card = (
    '🎉 <b>ВАША РАБОТА ПРИНЯТА И ОЦЕНЕНА!</b>\n\n' +
    `📌 <b>Задача:</b> #${task.id} — <b>${task.title}</b>\n` +
    `📂 <b>Цех:</b> <code>${task.direction}</code>\n` +
    `⭐ <b>Оценка:</b> <b>${score} / 10</b>\n` +
    `👑 <b>Проверил:</b> ${reviewer.name} (${reviewer.role})\n` +
    `📊 <b>Ваш новый средний балл:</b> <b>${assignee.average_score.toFixed(1)} / 10.0</b>\n` +
    `✅ <b>Закрыто задач:</b> ${assignee.completed_tasks}\n\n` +
    '<i>Отличная работа! Продолжайте в том же духе.</i>'
  );
  return await sendTelegramMessage(assignee.telegram_id, card);
}

async function notifyTaskRework(task, reviewer, notes = null) {
  if (!task.assigned_to_id) return false;
  const assignee = await db.get('SELECT * FROM users WHERE id = ?', [task.assigned_to_id]);
  if (!assignee || !assignee.telegram_id) return false;

  const notesText = notes ? `\n📝 <b>Замечания руководителя:</b>\n<i>${notes}</i>\n` : '';
  const card = (
    '⚠️ <b>ЗАДАЧА ОТПРАВЛЕНА НА ДОРАБОТКУ</b>\n\n' +
    `📌 <b>Задача:</b> #${task.id} — <b>${task.title}</b>\n` +
    `📂 <b>Цех:</b> <code>${task.direction}</code>\n` +
    `👑 <b>Руководитель:</b> ${reviewer.name} (${reviewer.role})\n` +
    notesText + '\n' +
    '⚡ <i>Пожалуйста, внесите необходимые исправления и загрузите обновленный результат на сайте.</i>'
  );
  return await sendTelegramMessage(assignee.telegram_id, card);
}

async function notifyTaskForceAssigned(task, assignee, assigner, note = null) {
  if (!assignee || !assignee.telegram_id) return false;

  const deadlineStr = task.deadline ? task.deadline.replace('T', ' ') : 'Не установлен';
  const noteText = note && note.trim() ? `\n💬 <b>Указание руководителя:</b>\n<i>${note.trim()}</i>\n` : '';

  const card = (
    '⚡ <b>ВАМ ПРИНУДИТЕЛЬНО ВЫДАНА ЗАДАЧА!</b>\n\n' +
    `📌 <b>Задача:</b> #${task.id} — <b>${task.title}</b>\n` +
    `📂 <b>Цех:</b> <code>${task.direction}</code>\n` +
    `👤 <b>Назначил:</b> <b>${assigner ? assigner.name : 'Руководство'}</b> (${assigner ? assigner.role : 'Руководство'})\n` +
    `⏰ <b>Дедлайн:</b> <code>${deadlineStr}</code>\n` +
    `📝 <b>Техническое задание:</b>\n${task.description}\n` +
    noteText + '\n' +
    `🌐 <a href="http://localhost:8000/task/${task.id}">Открыть задачу на платформе</a>`
  );

  return await sendTelegramMessage(assignee.telegram_id, card);
}

async function notifyTaskComment(task, author, commentText) {
  let sentCount = 0;
  const messageCard = (
    '💬 <b>НОВОЕ СООБЩЕНИЕ В ЧАТЕ ЗАДАЧИ!</b>\n\n' +
    `📌 <b>Задача #${task.id}:</b> <i>${task.title}</i> (${task.direction})\n` +
    `👤 <b>Отправитель:</b> <b>${author.name}</b> (${author.role}, Ур. ${author.access_level})\n\n` +
    `✉️ <b>Сообщение:</b>\n«${commentText}»\n\n` +
    `🌐 <a href="http://localhost:8000/task/${task.id}#comments">Открыть диалог по задаче на сайте</a>`
  );

  // If author is assignee -> notify managers
  if (task.assigned_to_id === author.id) {
    const managers = await db.all(
      'SELECT telegram_id FROM users WHERE access_level >= 3 AND telegram_id IS NOT NULL'
    );
    for (const m of managers) {
      if (m.telegram_id && m.telegram_id !== author.telegram_id) {
        const ok = await sendTelegramMessage(m.telegram_id, messageCard);
        if (ok) sentCount++;
      }
    }
  } else {
    // Author is manager -> notify assignee
    if (task.assigned_to_id) {
      const assignee = await db.get('SELECT telegram_id FROM users WHERE id = ?', [task.assigned_to_id]);
      if (assignee && assignee.telegram_id && assignee.telegram_id !== author.telegram_id) {
        const ok = await sendTelegramMessage(assignee.telegram_id, messageCard);
        if (ok) sentCount++;
      }
    }
  }
  return sentCount;
}

async function sendTestNotification(chatId = null) {
  const target = chatId || getLeadershipChatId();
  if (!target) return false;
  const text = (
    '🔔 <b>ТЕСТОВОЕ ОПОВЕЩЕНИЕ МЕДИАЦЕНТРА</b>\n\n' +
    '✅ Связь платформы с Telegram-ботом работает корректно!\n' +
    '🚀 Система переведена на высокопроизводительный Node.js движок.\n' +
    '⚡ Оценки, комментарии и материалы синхронизируются мгновенно.'
  );
  return await sendTelegramMessage(target, text);
}

// Telegram Worker class with long polling
class TelegramBotWorker {
  constructor() {
    this.running = false;
    this.offset = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    console.log('[TelegramBot] Starting Telegram bot polling worker...');
    this.pollLoop();
  }

  stop() {
    this.running = false;
    console.log('[TelegramBot] Telegram bot worker stopped.');
  }

  async pollLoop() {
    let consecutiveErrors = 0;
    while (this.running) {
      try {
        const token = getBotToken();
        if (!token) {
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        const res = await callTelegramApi('getUpdates', {
          offset: this.offset,
          timeout: 20
        }, 30000);

        if (res && res.ok && Array.isArray(res.result)) {
          consecutiveErrors = 0;
          for (const update of res.result) {
            this.offset = update.update_id + 1;
            await this.handleUpdate(update);
          }
        } else {
          if (!res) {
            consecutiveErrors++;
            if (consecutiveErrors === 1 || consecutiveErrors % 15 === 0) {
              console.warn(`[TelegramBot] getUpdates failed (${consecutiveErrors} раз подряд). Провайдер блокирует api.telegram.org:443. Требуется VPN, прокси или зеркало.`);
            }
            const delay = Math.min(15000, 3000 + consecutiveErrors * 1000);
            await new Promise(r => setTimeout(r, delay));
          } else {
            consecutiveErrors = 0;
            await new Promise(r => setTimeout(r, 1000));
          }
        }
      } catch (err) {
        consecutiveErrors++;
        if (consecutiveErrors === 1 || consecutiveErrors % 15 === 0) {
          console.warn('[TelegramBot] Polling loop error:', err.message);
        }
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  async handleUpdate(update) {
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
    } else if (update.message) {
      await this.handleMessage(update.message);
    }
  }

  async handleCallbackQuery(cb) {
    const cbId = cb.id;
    const cbData = cb.data || '';
    const fromUser = cb.from || {};
    const tgUserId = String(fromUser.id);
    const tgUsername = fromUser.username;
    const msg = cb.message;

    if (cbData.startsWith('rework:')) {
      const parts = cbData.split(':');
      if (parts.length !== 2 || isNaN(parts[1])) {
        await answerCallbackQuery(cbId, 'Некорректный запрос', true);
        return;
      }
      const taskId = parseInt(parts[1], 10);
      const res = await applyTaskReworkByTgUser(taskId, tgUserId, tgUsername, 'Возвращено на доработку через Telegram');
      if (!res.success) {
        await answerCallbackQuery(cbId, res.message, true);
        return;
      }
      await answerCallbackQuery(cbId, `🔄 Задача #${taskId} отправлена на доработку!`);
      if (msg) {
        const chatId = String(msg.chat.id);
        const messageId = msg.message_id;
        const assignee = res.task.assigned_to_id ? await db.get('SELECT name FROM users WHERE id = ?', [res.task.assigned_to_id]) : null;
        const assigneeName = assignee ? assignee.name : 'Исполнитель';
        const cardUpdated = (
          '🔄 <b>ЗАДАЧА ОТПРАВЛЕНА НА ДОРАБОТКУ!</b>\n\n' +
          `📌 <b>Задача:</b> #${res.task.id} — <b>${res.task.title}</b>\n` +
          `📂 <b>Цех:</b> <code>${res.task.direction}</code>\n` +
          `👤 <b>Исполнитель:</b> ${assigneeName}\n` +
          `👑 <b>Отправил:</b> ${res.grader.name} (${res.grader.role})\n\n` +
          '⚡ <i>Исполнителю направлено уведомление о необходимости правок.</i>'
        );
        await editTelegramMessage(chatId, messageId, cardUpdated, { inline_keyboard: [] });
      }
      return;
    }

    if (cbData.startsWith('rate:')) {
      const parts = cbData.split(':');
      if (parts.length !== 3) {
        await answerCallbackQuery(cbId, 'Некорректный запрос', true);
        return;
      }
      const taskId = parseInt(parts[1], 10);
      const score = parseInt(parts[2], 10);
      const res = await applyTaskRatingByTgUser(taskId, score, tgUserId, tgUsername);
      if (!res.success) {
        await answerCallbackQuery(cbId, res.message, true);
        return;
      }

      await answerCallbackQuery(cbId, `✅ Оценка ${score}/10 сохранена!`);
      if (msg) {
        const chatId = String(msg.chat.id);
        const messageId = msg.message_id;
        const assignee = res.task.assigned_to_id ? await db.get('SELECT * FROM users WHERE id = ?', [res.task.assigned_to_id]) : null;
        const assigneeName = assignee ? assignee.name : 'Исполнитель';
        const avgScoreStr = assignee ? assignee.average_score.toFixed(1) : '—';

        const fileButton = {
          inline_keyboard: [[
            { text: '📁 Папка Google Диска ↗', url: gdriveService.getTargetFolderUrl() }
          ]]
        };
        if (res.task.file_link && res.task.file_link.startsWith('https://') && !res.task.file_link.includes('localhost') && !res.task.file_link.includes('127.0.0.1')) {
          fileButton.inline_keyboard[0].unshift({ text: '📂 Открыть файл ↗', url: res.task.file_link });
        }

        const cardUpdated = (
          '✅ <b>ЗАДАЧА ПРИНЯТА И ОЦЕНЕНА!</b>\n\n' +
          `📌 <b>Задача:</b> #${res.task.id} — <b>${res.task.title}</b>\n` +
          `📂 <b>Цех:</b> <code>${res.task.direction}</code>\n` +
          `👤 <b>Исполнитель:</b> ${assigneeName}\n` +
          `⭐ <b>Выставленная оценка:</b> <b>${score} / 10</b>\n` +
          `👑 <b>Проверил:</b> ${res.grader.name} (${res.grader.role})\n` +
          `📊 <b>Новый рейтинг исполнителя:</b> <b>${avgScoreStr} / 10.0</b>\n\n` +
          '⚡ <i>Синхронизировано с сайтом медиацентра в реальном времени.</i>'
        );
        await editTelegramMessage(chatId, messageId, cardUpdated, fileButton);
      }
      return;
    }

    await answerCallbackQuery(cbId);
  }

  async handleMessage(message) {
    const chat = message.chat || {};
    const chatId = String(chat.id);
    const rawText = (message.text || '').trim();
    const fromUser = message.from || {};
    const tgUserId = String(fromUser.id);
    const tgUsername = fromUser.username;
    const userName = fromUser.first_name || 'Участник';

    const document = message.document;
    const photo = message.photo;
    const video = message.video;

    if (!rawText && !document && !photo && !video) return;

    if (document || photo || video) {
      await this.handleFileSubmission(message, chatId, tgUserId, tgUsername, userName);
      return;
    }

    // Find linked user
    let linkedUser = await db.get('SELECT * FROM users WHERE telegram_id = ?', [chatId]);
    if (!linkedUser && tgUserId) {
      linkedUser = await db.get('SELECT * FROM users WHERE telegram_id = ?', [tgUserId]);
    }
    if (!linkedUser && tgUsername) {
      const cleanU = tgUsername.replace('@', '').toLowerCase();
      linkedUser = await db.get(
        'SELECT * FROM users WHERE telegram_id LIKE ? OR LOWER(username) = ?',
        [`%${cleanU}%`, cleanU]
      );
      if (linkedUser) {
        await db.run('UPDATE users SET telegram_id = ? WHERE id = ?', [chatId, linkedUser.id]);
      }
    }

    // Normalize text (lower case, remove emojis)
    const cleanText = rawText
      .toLowerCase()
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
      .trim();

    // 1. /start bind_ID
    if (rawText.startsWith('/start bind_')) {
      const uidStr = rawText.split('bind_')[1].trim();
      const uid = parseInt(uidStr, 10);
      if (!isNaN(uid)) {
        const targetUser = await db.get('SELECT * FROM users WHERE id = ?', [uid]);
        if (targetUser) {
          await db.run('UPDATE users SET telegram_id = ? WHERE id = ?', [chatId, targetUser.id]);
          const kbd = getMainReplyKeyboard(targetUser);
          const reply = (
            '🎉 <b>АККАУНТ УСПЕШНО ПРИВЯЗАН!</b>\n\n' +
            `👤 <b>Пользователь:</b> ${targetUser.name}\n` +
            `🔑 <b>Логин:</b> <code>@${targetUser.username}</code>\n` +
            `🏷️ <b>Цех:</b> ${targetUser.role} (Уровень ${targetUser.access_level})\n\n` +
            '✅ <b>Внизу экрана появились удобные плашки действий!</b>\n' +
            'Теперь вы можете просматривать задачи, дедлайны и сдавать материалы прямо здесь.'
          );
          await sendTelegramMessage(chatId, reply, kbd);
          return;
        }
      }
      await sendTelegramMessage(chatId, '❌ Пользователь с таким ID не найден на платформе.');
      return;
    }

    // 2. /start
    if (rawText === '/start') {
      const kbd = getMainReplyKeyboard(linkedUser);
      if (linkedUser) {
        const isLead = linkedUser.access_level >= 2;
        const reply = (
          `👋 Здравствуйте, <b>${linkedUser.name}</b>!\n\n` +
          `Ваш Telegram привязан к аккаунту: <code>@${linkedUser.username}</code> (${linkedUser.role}, Ур. ${linkedUser.access_level}).\n\n` +
          '🔘 <b>Внизу экрана доступны быстрые кнопки (плашки):</b>\n' +
          '• <b>📋 Мои задачи</b> — список ваших текущих дел\n' +
          '• <b>🔥 Горящие дедлайны</b> — задачи, требующие срочного внимания\n' +
          (isLead ? '• <b>📋 Задачи на проверке</b> — очередь сдачи с оценками 1–10\n• <b>📊 Статистика медиацентра</b> — сводка платформы\n' : '') +
          '• <b>👤 Мой профиль</b> — статус и статистика\n' +
          '• <b>ℹ️ Помощь</b> — команды и руководство\n\n' +
          '<i>Просто кликайте по плашкам внизу экрана!</i>'
        );
        await sendTelegramMessage(chatId, reply, kbd);
      } else {
        const reply = (
          `👋 Привет, <b>${userName}</b>! Я официальный бот медиацентра СГТУ (@ping_sstu_bot).\n\n` +
          'Чтобы привязать этот Telegram к вашему профилю на платформе:\n' +
          '1. Войдите на сайт медиацентра и в профиле нажмите <b>«Подключить Telegram»</b>\n' +
          '2. Или отправьте команду прямо сюда:\n' +
          '<code>/bind &lt;ваш_логин&gt; &lt;ваш_пароль&gt;</code>'
        );
        await sendTelegramMessage(chatId, reply, kbd);
      }
      return;
    }

    // 3. /bind <login> <pass>
    if (rawText.startsWith('/bind')) {
      const parts = rawText.split(/\s+/);
      if (parts.length === 3) {
        const login = parts[1].trim().toLowerCase();
        const pwd = parts[2].trim();
        const usr = await db.get('SELECT * FROM users WHERE LOWER(username) = ?', [login]);
        if (usr && db.verifyPassword(pwd, usr.password_hash)) {
          await db.run('UPDATE users SET telegram_id = ? WHERE id = ?', [chatId, usr.id]);
          const kbd = getMainReplyKeyboard(usr);
          await sendTelegramMessage(
            chatId,
            `✅ <b>Успешно!</b> Профиль <b>${usr.name}</b> (@${usr.username}, ${usr.role}) подключен к боту.\nВнизу активированы кнопки быстрого доступа.`,
            kbd
          );
        } else {
          await sendTelegramMessage(chatId, '❌ Неверный логин или пароль. Попробуйте еще раз.');
        }
      } else {
        await sendTelegramMessage(chatId, 'ℹ️ Формат команды: <code>/bind &lt;ваш_логин&gt; &lt;ваш_пароль&gt;</code>');
      }
      return;
    }

    // 4. Action: 📋 Мои задачи (/tasks, мои задачи)
    const isMyTasks = cleanText.includes('мои задачи') ||
                      cleanText === 'задачи' ||
                      cleanText === '/tasks' ||
                      cleanText === 'tasks' ||
                      cleanText === 'мои дела' ||
                      cleanText === 'список задач';

    if (isMyTasks) {
      if (!linkedUser) {
        await sendTelegramMessage(
          chatId,
          '⚠️ <b>Telegram не привязан к профилю!</b>\n\n' +
          'Чтобы смотреть свои задачи, привяжите аккаунт:\n' +
          '<code>/bind &lt;логин&gt; &lt;пароль&gt;</code>'
        );
        return;
      }

      const tasks = await db.all(
        `SELECT * FROM tasks 
         WHERE assigned_to_id = ? AND status != 'done' 
         ORDER BY 
           CASE WHEN deadline IS NOT NULL AND TRIM(deadline) != '' THEN 0 ELSE 1 END ASC, 
           deadline ASC, 
           id DESC`,
        [linkedUser.id]
      );

      if (!tasks || tasks.length === 0) {
        await sendTelegramMessage(
          chatId,
          `🎉 <b>${linkedUser.name}</b>, у вас нет активных задач!\nВсе назначенные задачи закрыты или вы еще не взяли новую работу в контент-плане.`
        );
        return;
      }

      const now = new Date();
      const lines = [
        `📋 <b>ВАШИ АКТИВНЫЕ ЗАДАЧИ (${tasks.length}):</b>`,
        '━━━━━━━━━━━━━━━━━━'
      ];

      tasks.forEach((t, i) => {
        let statusIcon = '⏳';
        let statusName = 'В работе';
        if (t.status === 'review') {
          statusIcon = '🔍';
          statusName = 'На проверке';
        } else if (t.status === 'rework') {
          statusIcon = '🔄';
          statusName = 'На доработке';
        } else if (t.status === 'open') {
          statusIcon = '🟢';
          statusName = 'Свободна';
        }

        let deadlineInfo = '⏰ <b>Срок:</b> не установлен';
        if (t.deadline) {
          const dDate = new Date(t.deadline);
          const diffHours = (dDate - now) / (1000 * 60 * 60);
          const dateStr = t.deadline.replace('T', ' ');
          if (diffHours < 0) {
            deadlineInfo = `🔥 <b>ПРОСРОЧЕН:</b> <code>${dateStr}</code>`;
          } else if (diffHours <= 48) {
            deadlineInfo = `⚡ <b>ГОРИТ (осталось &lt; ${Math.round(diffHours)} ч):</b> <code>${dateStr}</code>`;
          } else {
            deadlineInfo = `⏰ <b>Дедлайн:</b> <code>${dateStr}</code>`;
          }
        }

        lines.push(`<b>${i + 1}. #${t.id} — ${t.title}</b>`);
        lines.push(`   ${statusIcon} <i>Статус:</i> ${statusName} | 🎯 <i>Цех:</i> <code>${t.direction}</code>`);
        lines.push(`   ${deadlineInfo}`);
        if (t.rework_notes && t.status === 'rework') {
          lines.push(`   ⚠️ <i>Замечания:</i> ${t.rework_notes}`);
        }
        lines.push('');
      });

      lines.push('💡 <i>Чтобы сдать работу, отправьте файл или фото сюда с подписью номера задачи (например: <code>#' + tasks[0].id + '</code>).</i>');
      await sendTelegramMessage(chatId, lines.join('\n'));
      return;
    }

    // 5. Action: 🔥 Горящие дедлайны (/urgent, горящие дедлайны)
    const isUrgent = cleanText.includes('горящие') ||
                     cleanText.includes('дедлайн') ||
                     cleanText === '/urgent' ||
                     cleanText === '/deadlines' ||
                     cleanText === 'deadlines' ||
                     cleanText === 'срочные' ||
                     cleanText.includes('горят');

    if (isUrgent) {
      if (!linkedUser) {
        await sendTelegramMessage(
          chatId,
          '⚠️ <b>Telegram не привязан к профилю!</b>\n\n' +
          'Чтобы смотреть свои дедлайны, привяжите аккаунт:\n' +
          '<code>/bind &lt;логин&gt; &lt;пароль&gt;</code>'
        );
        return;
      }

      const tasks = await db.all(
        `SELECT * FROM tasks 
         WHERE assigned_to_id = ? AND status != 'done' AND deadline IS NOT NULL AND TRIM(deadline) != ''
         ORDER BY deadline ASC`,
        [linkedUser.id]
      );

      const now = new Date();
      const urgentList = tasks.filter(t => {
        const dDate = new Date(t.deadline);
        const diffHours = (dDate - now) / (1000 * 60 * 60);
        return diffHours <= 48; // Overdue or <= 48h
      });

      if (!urgentList || urgentList.length === 0) {
        await sendTelegramMessage(
          chatId,
          `✅ <b>${linkedUser.name}</b>, у вас нет горящих дедлайнов (менее 48 часов)!\nПо всем вашим задачам запас времени достаточный.`
        );
        return;
      }

      const lines = [
        `🔥 <b>ГОРЯЩИЕ ДЕДЛАЙНЫ (${urgentList.length}):</b>`,
        '━━━━━━━━━━━━━━━━━━'
      ];

      urgentList.forEach((t, i) => {
        const dDate = new Date(t.deadline);
        const diffHours = (dDate - now) / (1000 * 60 * 60);
        const dateStr = t.deadline.replace('T', ' ');

        let tag = '⚡ <b>СРОЧНО:</b>';
        if (diffHours < 0) tag = '🔥 <b>ПРОСРОЧЕН:</b>';
        else if (diffHours <= 24) tag = '⚡ <b>ГОРИТ СЕГОДНЯ:</b>';

        lines.push(`<b>${i + 1}. #${t.id} — ${t.title}</b>`);
        lines.push(`   ${tag} <code>${dateStr}</code>`);
        lines.push(`   <i>Статус:</i> ${t.status === 'rework' ? 'На доработке' : 'В работе'} | 🎯 <i>Цех:</i> <code>${t.direction}</code>`);
        lines.push('');
      });

      lines.push('⚡ <i>Постарайтесь завершить и сдать работу до истечения срока!</i>');
      await sendTelegramMessage(chatId, lines.join('\n'));
      return;
    }

    // 5.1. Action: 🟢 Свободные задачи (/open, свободные)
    const isOpenTasks = cleanText.includes('свободные') ||
                        cleanText.includes('открытые') ||
                        cleanText === '/open' ||
                        cleanText === 'open' ||
                        cleanText === 'доступные задачи';

    if (isOpenTasks) {
      const openTasks = await db.all(
        `SELECT * FROM tasks 
         WHERE status = 'open' 
         ORDER BY 
           CASE WHEN deadline IS NOT NULL AND TRIM(deadline) != '' THEN 0 ELSE 1 END ASC, 
           deadline ASC, 
           id DESC`
      );

      if (!openTasks || openTasks.length === 0) {
        await sendTelegramMessage(
          chatId,
          '🎉 <b>В контент-плане сейчас нет свободных задач!</b>\nВсе задачи распределены по участникам или уже завершены.'
        );
        return;
      }

      const now = new Date();
      const lines = [
        `🟢 <b>СВОБОДНЫЕ ЗАДАЧИ В КОНТЕНТ-ПЛАНЕ (${openTasks.length}):</b>`,
        '━━━━━━━━━━━━━━━━━━'
      ];

      openTasks.forEach((t, i) => {
        let deadlineInfo = '⏰ <b>Срок:</b> не установлен';
        if (t.deadline) {
          const dDate = new Date(t.deadline);
          const diffHours = (dDate - now) / (1000 * 60 * 60);
          const dateStr = t.deadline.replace('T', ' ');
          if (diffHours < 0) {
            deadlineInfo = `🔥 <b>ПРОСРОЧЕН:</b> <code>${dateStr}</code>`;
          } else if (diffHours <= 48) {
            deadlineInfo = `⚡ <b>ГОРИТ (&lt; ${Math.round(diffHours)} ч):</b> <code>${dateStr}</code>`;
          } else {
            deadlineInfo = `⏰ <b>Дедлайн:</b> <code>${dateStr}</code>`;
          }
        }

        const isMyDir = (linkedUser && linkedUser.role === t.direction) ? ' ⭐ (Ваш цех!)' : '';
        lines.push(`<b>${i + 1}. #${t.id} — ${t.title}</b>${isMyDir}`);
        lines.push(`   🎯 <i>Цех:</i> <code>${t.direction}</code> | ${deadlineInfo}`);
        if (t.description) {
          const descPreview = t.description.length > 70 ? t.description.substring(0, 67) + '...' : t.description;
          lines.push(`   📝 <i>ТЗ:</i> ${descPreview}`);
        }
        lines.push('');
      });

      lines.push('🌐 <i>Взять задачу в работу можно на платформе:</i> <a href="http://localhost:8000/content-plan">Открыть Контент-план</a>');
      await sendTelegramMessage(chatId, lines.join('\n'));
      return;
    }

    // 6. Action: 👤 Мой профиль (/profile, /me, мой профиль)
    const isProfile = cleanText.includes('профиль') ||
                      cleanText === '/profile' ||
                      cleanText === '/me' ||
                      cleanText === 'мой аккаунт' ||
                      cleanText === 'аккаунт';

    if (isProfile) {
      if (!linkedUser) {
        await sendTelegramMessage(
          chatId,
          '👤 <b>ВАШ TELEGRAM НЕ ПРИВЯЗАН К ПЛАТФОРМЕ</b>\n\n' +
          `🆔 Ваш Chat ID: <code>${chatId}</code>\n\n` +
          'Чтобы привязать аккаунт:\n' +
          '1. Откройте профиль на сайте и нажмите «Подключить Telegram»\n' +
          '2. Или напишите команду прямо сюда:\n' +
          '<code>/bind &lt;ваш_логин&gt; &lt;пароль&gt;</code>'
        );
        return;
      }

      const roleLabels = { 1: 'Участник', 2: 'Глава цеха', 3: 'Руководитель', 4: 'Главный Администратор' };
      const levelTitle = roleLabels[linkedUser.access_level] || `Уровень ${linkedUser.access_level}`;
      const avgScore = (linkedUser.average_score || 0).toFixed(1);

      const profileCard = (
        '👤 <b>ВАШ ПРОФИЛЬ В МЕДИАЦЕНТРЕ СГТУ:</b>\n\n' +
        `👤 <b>ФИО:</b> ${linkedUser.name}\n` +
        `🔑 <b>Логин:</b> <code>@${linkedUser.username}</code>\n` +
        `🏷️ <b>Цех:</b> <b>${linkedUser.role}</b>\n` +
        `👑 <b>Должность:</b> ${levelTitle} (Ур. ${linkedUser.access_level})\n` +
        `⭐ <b>Средний балл:</b> <b>${avgScore} / 10.0</b>\n` +
        `✅ <b>Сдано и закрыто задач:</b> <b>${linkedUser.completed_tasks || 0}</b>\n` +
        `🆔 <b>Telegram Chat ID:</b> <code>${chatId}</code>\n\n` +
        `🌐 <a href="http://localhost:8000/profile/${linkedUser.id}">Открыть профиль на сайте</a>`
      );
      await sendTelegramMessage(chatId, profileCard);
      return;
    }

    // 7. Action: 📋 Задачи на проверке (/review, задачи на проверке)
    const isReview = cleanText.includes('на проверке') ||
                     cleanText.includes('проверка') ||
                     cleanText === '/review' ||
                     cleanText === 'очередь';

    if (isReview) {
      if (!linkedUser) {
        await sendTelegramMessage(
          chatId,
          '⚠️ <b>Ваш Telegram пока не привязан к профилю руководителя.</b>\n\n' +
          'Чтобы проверять и оценивать задачи:\n' +
          '<code>/bind &lt;ваш_логин&gt; &lt;ваш_пароль&gt;</code>'
        );
        return;
      }

      if (linkedUser.access_level < 2) {
        await sendTelegramMessage(
          chatId,
          `🔒 Доступ к очереди проверки разрешен главам цехов (2+) и руководству (3–4).\nВаш текущий профиль: ${linkedUser.name} (${linkedUser.role}, Ур. ${linkedUser.access_level}).`
        );
        return;
      }

      const reviewTasks = await db.all('SELECT * FROM tasks WHERE status = "review" ORDER BY id DESC');
      if (reviewTasks.length > 0) {
        const gdriveFolderUrl = gdriveService.getTargetFolderUrl();
        const header = (
          `📋 <b>В очереди на проверку: ${reviewTasks.length} задач(и).</b>\n\n` +
          `📁 <b>Google Диск команды:</b> <a href="${gdriveFolderUrl}">Открыть папку сдачи</a>\n` +
          'Выберите оценку от 1 до 10 для нужного задания кнопками ниже:'
        );
        await sendTelegramMessage(chatId, header);

        for (const t of reviewTasks.slice(0, 10)) {
          let assigneeName = 'Не назначен';
          if (t.assigned_to_id) {
            const assignee = await db.get('SELECT name FROM users WHERE id = ?', [t.assigned_to_id]);
            if (assignee) assigneeName = assignee.name;
          }

          const fileBadge = t.file_name ? `📎 <b>Сданный файл:</b> <code>${t.file_name}</code>\n` : '';
          const deadlineBadge = t.deadline ? `⏰ <b>Дедлайн:</b> <code>${t.deadline.replace('T', ' ')}</code>\n` : '';
          const fileInfoLine = t.file_link ? `🔗 <b>Ссылка / файл:</b> ${t.file_link}\n` : '';

          const card = (
            `📌 <b>Задача #${t.id}</b> — <b>${t.title}</b>\n` +
            `📂 <b>Цех:</b> <code>${t.direction}</code> | 👤 <b>Исполнитель:</b> ${assigneeName}\n` +
            deadlineBadge +
            fileBadge +
            fileInfoLine + '\n' +
            '⭐ <b>Поставьте оценку прямо здесь (1–10):</b>'
          );
          const kbd = getRatingKeyboard(t.id, t.file_link);
          await sendTelegramMessage(chatId, card, kbd);
        }
      } else {
        await sendTelegramMessage(chatId, '🎉 <b>Очередь проверки пуста!</b>\nВсе сданные задачи уже проверены и закрыты.');
      }
      return;
    }

    // 8. Action: 📊 Статистика медиацентра (/stats, статистика)
    const isStats = cleanText.includes('статистика') ||
                    cleanText === '/stats' ||
                    cleanText === 'сводка';

    if (isStats) {
      const totalUsers = (await db.get('SELECT COUNT(*) as c FROM users WHERE is_approved = 1')).c;
      const doneCount = (await db.get('SELECT COUNT(*) as c FROM tasks WHERE status = "done"')).c;
      const reviewCount = (await db.get('SELECT COUNT(*) as c FROM tasks WHERE status = "review"')).c;
      const inProgCount = (await db.get('SELECT COUNT(*) as c FROM tasks WHERE status = "in_progress"')).c;

      const msgStats = (
        '📊 <b>СТАТИСТИКА МЕДИАЦЕНТРА СГТУ</b>\n\n' +
        `👥 Участников команды: <b>${totalUsers}</b>\n` +
        `✅ Закрыто задач: <b>${doneCount}</b>\n` +
        `⏳ В работе сейчас: <b>${inProgCount}</b>\n` +
        `🔍 Ожидают проверки: <b>${reviewCount}</b>\n\n` +
        '🌐 Платформа: <a href="http://localhost:8000">http://localhost:8000</a>'
      );
      await sendTelegramMessage(chatId, msgStats);
      return;
    }

    // 9. Action: ℹ️ Помощь (/help, помощь, справка)
    const isHelp = cleanText.includes('помощь') ||
                   cleanText.includes('справка') ||
                   cleanText === '/help' ||
                   cleanText === 'help';

    if (isHelp) {
      const isLead = linkedUser && linkedUser.access_level >= 2;
      const helpText = (
        'ℹ️ <b>СПРАВКА ПО БОТУ МЕДИАЦЕНТРА (@ping_sstu_bot):</b>\n\n' +
        '🔘 <b>Быстрые кнопки внизу экрана (плашки):</b>\n' +
        '• <b>📋 Мои задачи</b> — список ваших задач в работе и на доработке\n' +
        '• <b>🔥 Горящие дедлайны</b> — задачи со сроком менее 48ч или просроченные\n' +
        '• <b>🟢 Свободные задачи</b> — просмотр открытых задач в контент-плане\n' +
        (isLead ? '• <b>📋 Задачи на проверке</b> — очередь работ с кнопками быстрой оценки (1–10)\n• <b>📊 Статистика медиацентра</b> — сводка команды\n' : '') +
        '• <b>👤 Мой профиль</b> — ваши данные, цех, уровень и рейтинг\n' +
        '• <b>ℹ️ Помощь</b> — эта справка\n\n' +
        '📤 <b>Сдача работ:</b>\n' +
        'Просто отправьте боту файл, фото или видео с указанием номера задачи в подписи (например: <code>#12</code>).\n\n' +
        '⌨️ <b>Текстовые команды:</b>\n' +
        '• <code>/bind &lt;логин&gt; &lt;пароль&gt;</code> — связать аккаунт\n' +
        '• <code>/rate &lt;ID&gt; &lt;оценка&gt;</code> — оценить задачу текстом\n' +
        '• <code>/rework &lt;ID&gt; [замечания]</code> — вернуть на доработку\n' +
        '• <code>/myid</code> — показать ваш цифровой Chat ID\n' +
        '• <code>/unbind</code> — отвязать Telegram'
      );
      await sendTelegramMessage(chatId, helpText);
      return;
    }

    // 10. /rate <task_id> <score>
    if (rawText.startsWith('/rate') || rawText.startsWith('/grade') || rawText.startsWith('/оценить')) {
      const parts = rawText.split(/\s+/);
      if (parts.length === 3 && !isNaN(parts[1]) && !isNaN(parts[2])) {
        const tid = parseInt(parts[1], 10);
        const sc = parseInt(parts[2], 10);
        const res = await applyTaskRatingByTgUser(tid, sc, tgUserId, tgUsername);
        await sendTelegramMessage(chatId, res.message);
      } else {
        await sendTelegramMessage(chatId, 'ℹ️ Формат команды: <code>/rate &lt;ID_задачи&gt; &lt;оценка_от_1_до_10&gt;</code> (напр. <code>/rate 5 10</code>)');
      }
      return;
    }

    // 11. /rework <task_id> [notes]
    if (rawText.startsWith('/rework') || rawText.startsWith('/доработка')) {
      const parts = rawText.split(/\s+/);
      if (parts.length >= 2 && !isNaN(parts[1])) {
        const tid = parseInt(parts[1], 10);
        const notes = parts.slice(2).join(' ').trim() || 'Возвращено на доработку руководителем';
        const res = await applyTaskReworkByTgUser(tid, tgUserId, tgUsername, notes);
        await sendTelegramMessage(chatId, res.message);
      } else {
        await sendTelegramMessage(chatId, 'ℹ️ Формат команды: <code>/rework &lt;ID_задачи&gt; [замечания]</code>');
      }
      return;
    }

    // 12. /setchat
    if (rawText.startsWith('/setchat') || rawText.startsWith('/register_chat')) {
      saveConfig({ leadership_group_chat_id: chatId });
      await sendTelegramMessage(
        chatId,
        '👑 <b>ЧАТ РУКОВОДСТВА УСПЕШНО ЗАРЕГИСТРИРОВАН!</b>\n\n' +
        `ID чата: <code>${chatId}</code> сохранен в системе.\nСюда будут направляться все сданные задачи с кнопками для выставления оценок.`
      );
      return;
    }

    // 13. /myid
    if (rawText === '/myid') {
      await sendTelegramMessage(chatId, `🆔 Ваш Telegram Chat ID: <code>${chatId}</code>`);
      return;
    }

    // 14. /unbind
    if (rawText === '/unbind' || cleanText === 'отвязать' || cleanText === 'выйти') {
      const usr = await db.get('SELECT * FROM users WHERE telegram_id = ?', [chatId]);
      if (usr) {
        await db.run('UPDATE users SET telegram_id = NULL WHERE id = ?', [usr.id]);
        await sendTelegramMessage(chatId, `✅ Аккаунт <b>${usr.name}</b> отвязан. Оповещения отключены.`, getMainReplyKeyboard(null));
      } else {
        await sendTelegramMessage(chatId, 'ℹ️ Ваш Telegram не был привязан ни к одному аккаунту.', getMainReplyKeyboard(null));
      }
      return;
    }

    // Default response for private chats
    if (!chatId.startsWith('-')) {
      await sendTelegramMessage(
        chatId,
        '💡 Используйте кнопки действий внизу экрана для быстрого просмотра задач и дедлайнов, либо отправьте <code>/help</code> для справки.'
      );
    }
  }

  async handleFileSubmission(message, chatId, tgUserId, tgUsername, userName) {
    let linkedUser = await db.get('SELECT * FROM users WHERE telegram_id = ?', [chatId]);
    if (!linkedUser) {
      linkedUser = await db.get('SELECT * FROM users WHERE telegram_id = ?', [tgUserId]);
    }
    if (!linkedUser && tgUsername) {
      const cleanU = tgUsername.replace('@', '').toLowerCase();
      linkedUser = await db.get('SELECT * FROM users WHERE LOWER(username) = ?', [cleanU]);
    }

    if (!linkedUser) {
      const msg = (
        '⚠️ <b>Telegram не привязан к аккаунту!</b>\n\n' +
        'Чтобы сдавать файлы через бота, привяжите свой профиль:\n' +
        '1. Нажмите «Подключить Telegram» в вашем профиле на сайте\n' +
        '2. Или отправьте команду: <code>/bind &lt;ваш_логин&gt; &lt;пароль&gt;</code>'
      );
      await sendTelegramMessage(chatId, msg);
      return;
    }

    const caption = (message.caption || '').trim();
    let targetTask = null;

    if (caption) {
      const match = caption.match(/#?(\d+)/);
      if (match) {
        const candId = parseInt(match[1], 10);
        const candTask = await db.get('SELECT * FROM tasks WHERE id = ?', [candId]);
        if (candTask && (candTask.assigned_to_id === linkedUser.id || linkedUser.access_level >= 4)) {
          targetTask = candTask;
        }
      }
    }

    if (!targetTask) {
      const userProgressTasks = await db.all(
        'SELECT * FROM tasks WHERE assigned_to_id = ? AND status IN ("in_progress", "rework") ORDER BY id DESC',
        [linkedUser.id]
      );

      if (userProgressTasks.length === 1) {
        targetTask = userProgressTasks[0];
      } else if (userProgressTasks.length > 1) {
        const statusLabels = { in_progress: 'в работе', rework: 'на доработке' };
        const taskList = userProgressTasks.map(t => `• <code>#${t.id}</code> — <b>${t.title}</b> (${t.direction}, статус: ${statusLabels[t.status] || t.status})`).join('\n');
        const msg = (
          '📌 <b>У вас несколько активных задач (в работе / на доработке):</b>\n\n' +
          `${taskList}\n\n` +
          `Пожалуйста, отправьте файл повторно, указав в подписи номер задачи (например: <code>#${userProgressTasks[0].id}</code>).`
        );
        await sendTelegramMessage(chatId, msg);
        return;
      } else {
        const msg = (
          'ℹ️ <b>У вас нет активных задач в работе или на доработке.</b>\n\n' +
          'Сначала возьмите задачу в Контент-плане на сайте, либо укажите номер задачи в подписи к файлу.'
        );
        await sendTelegramMessage(chatId, msg);
        return;
      }
    }

    // Extract file from message
    const token = getBotToken();
    let fileId = null;
    let origName = 'file.bin';

    if (message.document) {
      fileId = message.document.file_id;
      origName = message.document.file_name || `doc_${targetTask.id}.bin`;
    } else if (message.photo && message.photo.length > 0) {
      fileId = message.photo[message.photo.length - 1].file_id;
      origName = `photo_task_${targetTask.id}.jpg`;
    } else if (message.video) {
      fileId = message.video.file_id;
      origName = message.video.file_name || `video_${targetTask.id}.mp4`;
    }

    if (!fileId) {
      await sendTelegramMessage(chatId, '❌ Не удалось извлечь файл из сообщения.');
      return;
    }

    const cfg = getConfig();
    const baseUrl = (cfg.api_base_url || 'https://api.telegram.org').trim().replace(/\/+$/, '');
    const fileInfoRes = await callTelegramApi('getFile', { file_id: fileId });
    if (!fileInfoRes || !fileInfoRes.ok || !fileInfoRes.result) {
      await sendTelegramMessage(chatId, '❌ Не удалось получить ссылку на файл от Telegram.');
      return;
    }

    const filePath = fileInfoRes.result.file_path;
    const downloadUrl = `${baseUrl}/file/bot${token}/${filePath}`;
    const fetchOpts = { signal: AbortSignal.timeout(60000) };
    const dispatcher = getProxyDispatcher();
    if (dispatcher) fetchOpts.dispatcher = dispatcher;
    const fileResp = await fetch(downloadUrl, fetchOpts);
    const arrayBuffer = await fileResp.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuffer);

    const { fileLink, fileName: cleanName, gdriveRes } = await gdriveService.saveLocalAndSyncGdrive(
      fileBuffer,
      origName,
      targetTask.id
    );

    await db.run(
      'UPDATE tasks SET file_link = ?, file_name = ?, status = "review" WHERE id = ?',
      [fileLink, cleanName, targetTask.id]
    );
    targetTask.file_link = fileLink;
    targetTask.file_name = cleanName;
    targetTask.status = 'review';

    await notifyTaskSubmittedForReview(targetTask, linkedUser);

    const gdriveFolderUrl = gdriveService.getTargetFolderUrl();
    const gdriveNote = (gdriveRes && gdriveRes.web_link)
      ? `\n📁 Файл также синхронизирован в <a href="${gdriveFolderUrl}">Google Диск команды</a>`
      : `\n📁 Файл сохранен и доступен в <a href="${gdriveFolderUrl}">папке Google Диска</a>`;

    const confirmation = (
      '🎉 <b>ФАЙЛ УСПЕШНО ПРИНЯТ И ОТПРАВЛЕН!</b>\n\n' +
      `📌 <b>Задача:</b> <code>#${targetTask.id}</code> — <b>${targetTask.title}</b>\n` +
      `📎 <b>Файл:</b> <code>${cleanName}</code>\n` +
      '🔍 <b>Статус:</b> <code>На проверке у руководства (review)</code>\n' +
      `${gdriveNote}\n\n` +
      '⚡ Руководители получили уведомление и кнопки для проверки и выставления оценки.'
    );
    await sendTelegramMessage(chatId, confirmation);
  }
}

const botWorker = new TelegramBotWorker();

module.exports = {
  getConfig,
  saveConfig,
  getBotToken,
  getBotUsername,
  getLeadershipChatId,
  getMainReplyKeyboard,
  sendTelegramMessage,
  editTelegramMessage,
  answerCallbackQuery,
  getRatingKeyboard,
  applyTaskRatingByTgUser,
  applyTaskReworkByTgUser,
  notifyTaskSubmittedForReview,
  notifyNewUserRegistered,
  notifyTaskGraded,
  notifyTaskRework,
  notifyTaskForceAssigned,
  notifyTaskComment,
  sendTestNotification,
  testTelegramConnection,
  botWorker
};
