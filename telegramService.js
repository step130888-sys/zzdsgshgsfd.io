const fs = require('fs');
const path = require('path');
const db = require('./db');
const gdriveService = require('./gdriveService');

const CONFIG_PATH = path.join(__dirname, 'bot_config.json');

function getConfig() {
  const defaults = {
    bot_token: '8837250732:AAGS9Z_PoAuJQdQbDyFJ5us1ny1CmHSs0mc',
    bot_username: 'ping_sstu_bot',
    leadership_group_chat_id: null
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

async function callTelegramApi(method, body = {}) {
  const token = getBotToken();
  if (!token) return null;
  const url = `https://api.telegram.org/bot${token}/${method}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return await res.json();
  } catch (err) {
    console.error(`Telegram API error on ${method}:`, err.message);
    return null;
  }
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
  }
  const res = await callTelegramApi('sendMessage', body);
  return Boolean(res && res.ok);
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
        });

        if (res && res.ok && Array.isArray(res.result)) {
          for (const update of res.result) {
            this.offset = update.update_id + 1;
            await this.handleUpdate(update);
          }
        } else {
          await new Promise(r => setTimeout(r, 2000));
        }
      } catch (err) {
        console.error('[TelegramBot] Polling loop error:', err.message);
        await new Promise(r => setTimeout(r, 3000));
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
    const text = (message.text || '').trim();
    const fromUser = message.from || {};
    const tgUserId = String(fromUser.id);
    const tgUsername = fromUser.username;
    const userName = fromUser.first_name || 'Участник';

    const document = message.document;
    const photo = message.photo;
    const video = message.video;

    if (!text && !document && !photo && !video) return;

    if (document || photo || video) {
      await this.handleFileSubmission(message, chatId, tgUserId, tgUsername, userName);
      return;
    }

    // 1. /start bind_ID
    if (text.startsWith('/start bind_')) {
      const uidStr = text.split('bind_')[1].trim();
      const uid = parseInt(uidStr, 10);
      if (!isNaN(uid)) {
        const targetUser = await db.get('SELECT * FROM users WHERE id = ?', [uid]);
        if (targetUser) {
          await db.run('UPDATE users SET telegram_id = ? WHERE id = ?', [chatId, targetUser.id]);
          const reply = (
            '🎉 <b>АККАУНТ УСПЕШНО ПРИВЯЗАН!</b>\n\n' +
            `👤 <b>Пользователь:</b> ${targetUser.name}\n` +
            `🔑 <b>Логин:</b> <code>@${targetUser.username}</code>\n` +
            `🏷️ <b>Цех:</b> ${targetUser.role} (Уровень ${targetUser.access_level})\n\n` +
            '✅ Теперь вы будете мгновенно получать уведомления от платформы и сможете оценивать задачи прямо из Telegram!\n\n' +
            'Команды:\n' +
            '• <code>/review</code> — задачи на проверке с кнопками оценки\n' +
            '• <code>/stats</code> — сводка медиакоманды\n' +
            '• <code>/unbind</code> — отвязать Telegram'
          );
          await sendTelegramMessage(chatId, reply);
          return;
        }
      }
      await sendTelegramMessage(chatId, '❌ Пользователь с таким ID не найден на платформе.');
      return;
    }

    // 2. /start
    if (text === '/start') {
      let linkedUser = await db.get('SELECT * FROM users WHERE telegram_id = ?', [chatId]);
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

      if (linkedUser) {
        const reply = (
          `👋 Здравствуйте, <b>${linkedUser.name}</b>!\n\n` +
          `Ваш Telegram привязан к аккаунту <code>${linkedUser.username}</code> (${linkedUser.role}, Ур. ${linkedUser.access_level}).\n\n` +
          '📌 <b>Доступные команды:</b>\n' +
          '• <code>/review</code> — задачи на проверке с кнопками быстрой оценки\n' +
          '• <code>/rate &lt;id&gt; &lt;балл&gt;</code> — оценить задачу текстом\n' +
          '• <code>/rework &lt;id&gt; [замечания]</code> — вернуть задачу на доработку\n' +
          '• <code>/stats</code> — статистика медиацентра\n' +
          '• <code>/myid</code> — ваш цифровой Telegram Chat ID\n' +
          '• <code>/unbind</code> — отключить оповещения'
        );
        await sendTelegramMessage(chatId, reply);
      } else {
        const reply = (
          `👋 Привет, <b>${userName}</b>! Я официальный бот оповещений медиацентра СГТУ (<b>@ping_sstu_bot</b>).\n\n` +
          'Чтобы связать этот Telegram с вашим профилем на платформе:\n' +
          '1. Войдите на сайт медиацентра\n' +
          '2. Откройте <b>Профиль</b> или <b>Панель руководства</b>\n' +
          '3. Нажмите кнопку <b>«Подключить Telegram»</b>\n\n' +
          'Или напишите здесь:\n' +
          '<code>/bind &lt;логин&gt; &lt;пароль&gt;</code>'
        );
        await sendTelegramMessage(chatId, reply);
      }
      return;
    }

    // 3. /bind <login> <pass>
    if (text.startsWith('/bind')) {
      const parts = text.split(/\s+/);
      if (parts.length === 3) {
        const login = parts[1].trim().toLowerCase();
        const pwd = parts[2].trim();
        const usr = await db.get('SELECT * FROM users WHERE LOWER(username) = ?', [login]);
        if (usr && db.verifyPassword(pwd, usr.password_hash)) {
          await db.run('UPDATE users SET telegram_id = ? WHERE id = ?', [chatId, usr.id]);
          await sendTelegramMessage(
            chatId,
            `✅ <b>Успешно!</b> Профиль <b>${usr.name}</b> (@${usr.username}, ${usr.role}) подключен к боту.\nТеперь вы можете оценивать задачи прямо через Telegram.`
          );
        } else {
          await sendTelegramMessage(chatId, '❌ Неверный логин или пароль. Попробуйте еще раз.');
        }
      } else {
        await sendTelegramMessage(chatId, 'ℹ️ Формат команды: <code>/bind &lt;ваш_логин&gt; &lt;ваш_пароль&gt;</code>');
      }
      return;
    }

    // 4. /rate <task_id> <score>
    if (text.startsWith('/rate') || text.startsWith('/grade') || text.startsWith('/оценить')) {
      const parts = text.split(/\s+/);
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

    // 5. /rework <task_id> [notes]
    if (text.startsWith('/rework') || text.startsWith('/доработка')) {
      const parts = text.split(/\s+/);
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

    // 6. /review or /tasks
    if (text === '/review' || text === '/проверка' || text === '/tasks') {
      let userObj = await db.get('SELECT * FROM users WHERE telegram_id = ?', [tgUserId]);
      if (!userObj && chatId) {
        userObj = await db.get('SELECT * FROM users WHERE telegram_id = ?', [chatId]);
      }
      if (!userObj && tgUsername) {
        const cleanU = tgUsername.replace('@', '').toLowerCase();
        userObj = await db.get('SELECT * FROM users WHERE LOWER(username) = ?', [cleanU]);
        if (userObj) {
          await db.run('UPDATE users SET telegram_id = ? WHERE id = ?', [tgUserId, userObj.id]);
        }
      }

      if (!userObj) {
        await sendTelegramMessage(
          chatId,
          '⚠️ <b>Ваш Telegram пока не привязан к профилю руководителя.</b>\n\n' +
          'Чтобы проверять и оценивать задачи:\n' +
          '1. Нажмите «Привязать мой Telegram» в панели руководства на сайте\n' +
          '2. Или отправьте команду прямо сюда:\n' +
          '<code>/bind &lt;ваш_логин&gt; &lt;ваш_пароль&gt;</code>'
        );
        return;
      }

      if (userObj.access_level < 2) {
        await sendTelegramMessage(
          chatId,
          `🔒 Доступ к очереди проверки разрешен главам цехов (2+) и руководству (3–4).\nВаш текущий профиль: ${userObj.name} (Уровень ${userObj.access_level}, ${userObj.role}).`
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

    // 7. /setchat
    if (text.startsWith('/setchat') || text.startsWith('/register_chat')) {
      saveConfig({ leadership_group_chat_id: chatId });
      await sendTelegramMessage(
        chatId,
        '👑 <b>ЧАТ РУКОВОДСТВА УСПЕШНО ЗАРЕГИСТРИРОВАН!</b>\n\n' +
        `ID чата: <code>${chatId}</code> сохранен в системе.\nСюда будут направляться все сданные задачи с кнопками для выставления оценок.`
      );
      return;
    }

    // 8. /myid
    if (text === '/myid') {
      await sendTelegramMessage(chatId, `🆔 Ваш Telegram Chat ID: <code>${chatId}</code>`);
      return;
    }

    // 9. /stats
    if (text === '/stats') {
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
        'Платформа: http://localhost:8000'
      );
      await sendTelegramMessage(chatId, msgStats);
      return;
    }

    // 10. /unbind
    if (text === '/unbind') {
      const usr = await db.get('SELECT * FROM users WHERE telegram_id = ?', [chatId]);
      if (usr) {
        await db.run('UPDATE users SET telegram_id = NULL WHERE id = ?', [usr.id]);
        await sendTelegramMessage(chatId, `✅ Аккаунт <b>${usr.name}</b> отвязан. Оповещения отключены.`);
      } else {
        await sendTelegramMessage(chatId, 'ℹ️ Ваш Telegram не был привязан ни к одному аккаунту.');
      }
      return;
    }

    // 11. /help
    if (text === '/help') {
      const helpText = (
        'ℹ️ <b>Справка по боту оповещений (@ping_sstu_bot):</b>\n\n' +
        '• <code>/review</code> — задачи на проверке с кнопками оценки от 1 до 10\n' +
        '• <code>/rate &lt;ID&gt; &lt;оценка&gt;</code> — поставить оценку текстом\n' +
        '• <code>/start</code> — статус привязки аккаунта\n' +
        '• <code>/bind &lt;логин&gt; &lt;пароль&gt;</code> — подключить профиль\n' +
        '• <code>/stats</code> — сводка медиацентра\n' +
        '• <code>/setchat</code> — зарегистрировать группу для оповещений руководства\n' +
        '• <code>/myid</code> — показать ваш цифровой Chat ID\n' +
        '• <code>/unbind</code> — отвязать Telegram'
      );
      await sendTelegramMessage(chatId, helpText);
      return;
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

    const fileInfoRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
    const fileInfo = await fileInfoRes.json();
    if (!fileInfo || !fileInfo.ok) {
      await sendTelegramMessage(chatId, '❌ Не удалось получить ссылку на файл от Telegram.');
      return;
    }

    const filePath = fileInfo.result.file_path;
    const downloadUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
    const fileResp = await fetch(downloadUrl);
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
  notifyTaskComment,
  sendTestNotification,
  botWorker
};
