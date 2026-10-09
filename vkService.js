const fs = require('fs');
const path = require('path');
const db = require('./db');

const CONFIG_PATH = path.join(__dirname, 'vk_config.json');

function getConfig() {
  const defaults = {
    vk_group_token: '',
    vk_group_id: '',
    is_enabled: true
  };
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return Object.assign(defaults, data);
    } catch (e) {
      console.error('Error reading vk_config.json:', e);
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
    console.error('Error saving vk_config.json:', e);
  }
}

function getGroupToken() {
  return process.env.VK_GROUP_TOKEN || getConfig().vk_group_token || '';
}

function getGroupId() {
  const raw = process.env.VK_GROUP_ID || getConfig().vk_group_id || '';
  return String(raw).replace(/[^\d]/g, '');
}

/**
 * Call VK API method
 */
async function callVkApi(method, params = {}) {
  const token = getGroupToken();
  if (!token) return null;

  const url = `https://api.vk.com/method/${method}`;
  const formData = new URLSearchParams();
  formData.append('v', '5.199');
  formData.append('access_token', token);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      formData.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      body: formData
    });
    const json = await res.json();
    if (json.error) {
      const errMsg = json.error.error_msg || JSON.stringify(json.error);
      if (method === 'groups.getLongPollServer' && errMsg.includes('longpoll for this group is not enabled')) {
        console.warn('[VkBot] ⚠️ В настройках сообщества VK выключен Long Poll API! Включите: Управление -> Работа с API -> вкладка "Long Poll API" -> переключить на "Включено" (версия 5.199).');
      } else {
        console.error(`VK API error in ${method}:`, errMsg);
      }
      return null;
    }
    return json.response;
  } catch (err) {
    console.error(`Network error calling VK API ${method}:`, err.message);
    return null;
  }
}

/**
 * Resolve username/link/id to numeric user_id
 */
async function resolveNumericUserId(input) {
  if (!input) return null;
  let str = String(input).trim();
  str = str.replace(/^https?:\/\/(www\.|m\.)?vk\.(com|ru)\//i, '');
  str = str.replace(/^[/?#]+/, '');
  str = str.replace(/^@/, '');
  str = str.split('?')[0].split('#')[0].replace(/\/+$/, '');

  const idMatch = str.match(/^id(\d+)$/i);
  if (idMatch) {
    return parseInt(idMatch[1], 10);
  }
  if (/^\d+$/.test(str)) {
    return parseInt(str, 10);
  }

  // 1. users.get handles numeric IDs, screen names (e.g. daniilstepanov5) automatically
  try {
    const users = await callVkApi('users.get', { user_ids: str });
    if (Array.isArray(users) && users.length > 0 && users[0].id) {
      return parseInt(users[0].id, 10);
    }
  } catch (e) {}

  // 2. Fallback to utils.resolveScreenName
  try {
    const res = await callVkApi('utils.resolveScreenName', { screen_name: str });
    if (res && res.type === 'user' && res.object_id) {
      return parseInt(res.object_id, 10);
    }
  } catch (e) {}

  return null;
}

/**
 * Get standard Read-Only reply keyboard for VK bot
 */
function getMainKeyboard() {
  return {
    one_time: false,
    buttons: [
      [
        {
          action: {
            type: 'text',
            label: '📋 Мои задачи',
            payload: JSON.stringify({ button: 'my_tasks' })
          },
          color: 'primary' // Blue
        },
        {
          action: {
            type: 'text',
            label: '🔥 Горящие дедлайны',
            payload: JSON.stringify({ button: 'urgent_deadlines' })
          },
          color: 'negative' // Red
        }
      ],
      [
        {
          action: {
            type: 'text',
            label: '🟢 Свободные задачи',
            payload: JSON.stringify({ button: 'open_tasks' })
          },
          color: 'positive' // Green
        }
      ],
      [
        {
          action: {
            type: 'text',
            label: '👤 Мой профиль',
            payload: JSON.stringify({ button: 'my_profile' })
          },
          color: 'secondary' // White/Grey
        },
        {
          action: {
            type: 'text',
            label: 'ℹ️ Помощь',
            payload: JSON.stringify({ button: 'help' })
          },
          color: 'secondary'
        }
      ]
    ]
  };
}

/**
 * Send VK direct message to user
 */
async function sendVkMessage(userId, message, keyboard = null) {
  if (!userId) return false;
  const token = getGroupToken();
  if (!token) return false;

  const numericId = await resolveNumericUserId(userId);
  if (!numericId) {
    console.error(`[VkBot] Не удалось определить числовой ID для пользователя: '${userId}'. Укажите цифровой ID (например, 12345678).`);
    return false;
  }

  const params = {
    user_id: numericId,
    random_id: Math.floor(Math.random() * 2147483647),
    message: message
  };

  if (keyboard !== null) {
    params.keyboard = keyboard;
  } else {
    params.keyboard = getMainKeyboard();
  }

  let res = await callVkApi('messages.send', params);
  if (!res && keyboard === null) {
    // Retry without keyboard if bot keyboard features are not yet enabled in VK settings
    const fallbackParams = Object.assign({}, params);
    delete fallbackParams.keyboard;
    res = await callVkApi('messages.send', fallbackParams);
    if (res) {
      console.warn('[VkBot] ⚠️ Сообщение отправлено без кнопок, так как в группе выключены «Возможности ботов».');
      console.warn('[VkBot] 👉 Чтобы кнопки отображались: В группе откройте Управление -> Сообщения -> Настройки для бота -> Возможности ботов (Включены).');
    }
  }

  return Boolean(res);
}

/**
 * Notify assignee about newly assigned task
 */
async function notifyTaskAssigned(task, user) {
  if (!user || !user.vk_id) return false;

  const deadlineStr = task.deadline ? task.deadline.replace('T', ' ') : 'Не установлен';
  const text = [
    '📢 ВАМ НАЗНАЧЕНА НОВАЯ ЗАДАЧА!',
    '━━━━━━━━━━━━━━━━━━',
    `📌 Задача #${task.id}: «${task.title}»`,
    `🎯 Цех: ${task.direction}`,
    `⏰ Дедлайн: ${deadlineStr}`,
    `📝 Описание: ${task.description}`,
    '━━━━━━━━━━━━━━━━━━',
    '💡 Чтобы посмотреть все ваши текущие задачи и дедлайны, нажмите кнопку «📋 Мои задачи» ниже.'
  ].join('\n');

  return await sendVkMessage(user.vk_id, text);
}

/**
 * Notify assignee about forcefully assigned task from management
 */
async function notifyTaskForceAssigned(task, user, assignedBy, note = null) {
  if (!user || !user.vk_id) return false;

  const deadlineStr = task.deadline ? task.deadline.replace('T', ' ') : 'Не установлен';
  const lines = [
    '⚡ ВАМ ПРИНУДИТЕЛЬНО ВЫДАНА ЗАДАЧА!',
    '━━━━━━━━━━━━━━━━━━',
    `📌 Задача #${task.id}: «${task.title}»`,
    `🎯 Цех: ${task.direction}`,
    `👤 Назначил: ${assignedBy ? assignedBy.name : 'Руководство'} (${assignedBy ? assignedBy.role : 'Руководство'})`,
    `⏰ Дедлайн: ${deadlineStr}`,
    `📝 Техническое задание: ${task.description}`
  ];

  if (note && note.trim()) {
    lines.push(`💬 Указание руководителя: ${note.trim()}`);
  }

  lines.push('━━━━━━━━━━━━━━━━━━');
  lines.push('💡 Задача уже добавлена в ваш список «В работе». Нажмите «📋 Мои задачи» для просмотра.');

  return await sendVkMessage(user.vk_id, lines.join('\n'));
}

/**
 * Notify all direction members about a new open task
 */
async function notifyNewOpenTask(task) {
  const token = getGroupToken();
  if (!token) return false;

  const users = await db.all(
    'SELECT * FROM users WHERE role = ? AND is_approved = 1 AND vk_id IS NOT NULL',
    [task.direction]
  );
  if (!users || users.length === 0) return false;

  const deadlineStr = task.deadline ? task.deadline.replace('T', ' ') : 'Не установлен';
  const text = [
    `✨ НОВАЯ СВОБОДНАЯ ЗАДАЧА В ЦЕХЕ «${task.direction}»!`,
    '━━━━━━━━━━━━━━━━━━',
    `📌 Задача #${task.id}: «${task.title}»`,
    `⏰ Дедлайн: ${deadlineStr}`,
    `📝 Описание: ${task.description}`,
    '━━━━━━━━━━━━━━━━━━',
    '🚀 Зайдите на веб-платформу, чтобы взять её в работу!'
  ].join('\n');

  for (const u of users) {
    try {
      await sendVkMessage(u.vk_id, text);
    } catch (e) {
      console.error(`Failed to send VK notification to user #${u.id}:`, e);
    }
  }
  return true;
}

/**
 * Notify assignee when task is sent to rework
 */
async function notifyTaskRework(task, user, reworkNotes = '') {
  if (!user || !user.vk_id) return false;

  const deadlineStr = task.deadline ? task.deadline.replace('T', ' ') : 'Не установлен';
  const text = [
    '🔄 ЗАДАЧА ОТПРАВЛЕНА НА ДОРАБОТКУ',
    '━━━━━━━━━━━━━━━━━━',
    `📌 Задача #${task.id}: «${task.title}»`,
    `⏰ Срок: ${deadlineStr}`,
    `⚠️ Замечания руководителя:`,
    reworkNotes || 'Пожалуйста, проверьте комментарии на платформе.',
    '━━━━━━━━━━━━━━━━━━',
    'Внесите исправления и отправьте работу повторно через сайт.'
  ].join('\n');

  return await sendVkMessage(user.vk_id, text);
}

/**
 * Notify assignee when task deadline is changed
 */
async function notifyTaskDeadlineChanged(task, user, newDeadline) {
  if (!user || !user.vk_id) return false;

  const deadlineStr = newDeadline ? newDeadline.replace('T', ' ') : 'Снят';
  const text = [
    '⏰ ИЗМЕНЕН ДЕДЛАЙН ЗАДАЧИ',
    '━━━━━━━━━━━━━━━━━━',
    `📌 Задача #${task.id}: «${task.title}»`,
    `⏰ Новый срок сдачи: ${deadlineStr}`,
    '━━━━━━━━━━━━━━━━━━',
    'Нажмите «🔥 Горящие дедлайны», чтобы проверить все сроки.'
  ].join('\n');

  return await sendVkMessage(user.vk_id, text);
}

// -------------------------------------------------------------
// VK Message Handler (Read-Only)
// -------------------------------------------------------------

async function handleIncomingMessage(message) {
  if (!message || !message.from_id) return;
  const fromId = String(message.from_id);

  // Ignore group messages (negative from_id)
  if (message.from_id < 0) return;

  const rawText = (message.text || '').trim();
  const cleanText = rawText
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
    .trim();

  let payload = null;
  if (message.payload) {
    try {
      payload = JSON.parse(message.payload);
    } catch (e) {}
  }

  const btnAction = payload && payload.button ? payload.button : null;

  // Find linked user
  const user = await db.get('SELECT * FROM users WHERE vk_id = ?', [fromId]);

  // Command: Account binding (/login username password or /bind username password)
  if (rawText.startsWith('/login') || rawText.startsWith('/bind')) {
    const parts = rawText.split(/\s+/);
    if (parts.length < 3) {
      await sendVkMessage(
        fromId,
        '⚠️ Для привязки укажите логин и пароль:\n/login <логин> <пароль>\n\nПример:\n/login ivan_photo 123456'
      );
      return;
    }

    const username = parts[1].trim();
    const password = parts.slice(2).join(' ').trim();

    const candidate = await db.get('SELECT * FROM users WHERE username = ?', [username]);
    if (!candidate || !db.verifyPassword(password, candidate.password_hash)) {
      await sendVkMessage(
        fromId,
        '❌ Неверный логин или пароль от платформы. Проверьте данные и попробуйте снова.'
      );
      return;
    }

    // Bind VK ID to user
    await db.run('UPDATE users SET vk_id = ? WHERE id = ?', [fromId, candidate.id]);
    await sendVkMessage(
      fromId,
      `✅ Успешно! Аккаунт «${candidate.name}» (Цех: ${candidate.role}) привязан к вашему ВКонтакте.\n\nТеперь вы будете получать уведомления о задачах и можете проверять сроки прямо здесь!`
    );
    return;
  }

  // Command: Unlink (/unlink)
  if (cleanText === '/unlink' || cleanText === 'отвязать' || cleanText === 'выйти') {
    if (user) {
      await db.run('UPDATE users SET vk_id = NULL WHERE id = ?', [user.id]);
      await sendVkMessage(fromId, '👋 Ваш аккаунт успешно отвязан от бота.');
    } else {
      await sendVkMessage(fromId, 'У вас нет привязанного аккаунта.');
    }
    return;
  }

  // If user is NOT linked yet
  if (!user) {
    const unlinkedHelp = [
      '👋 Приветствуем в боте Медиацентра ОСО СГТУ им. Гагарина Ю.А.!',
      '━━━━━━━━━━━━━━━━━━',
      'Бот создан для просмотра ваших назначенных задач и получения уведомлений о дедлайнах.',
      '',
      '🔑 Чтобы привязать ваш профиль, отправьте сообщение:',
      '/login <ваш_логин> <ваш_пароль>',
      '',
      'Например:',
      '/login ivan_photo 1111',
      '',
      'Либо укажите ваш VK ID на сайте в личном профиле.'
    ].join('\n');
    await sendVkMessage(fromId, unlinkedHelp);
    return;
  }

  // Action 1: My Tasks (📋 Мои задачи)
  const isMyTasks = btnAction === 'my_tasks' ||
                    cleanText.includes('мои задачи') ||
                    cleanText === 'задачи' ||
                    cleanText === '/tasks' ||
                    cleanText === 'tasks' ||
                    cleanText === 'мои дела' ||
                    cleanText === 'список задач';

  if (isMyTasks) {
    const tasks = await db.all(
      `SELECT * FROM tasks 
       WHERE assigned_to_id = ? AND status != 'done' 
       ORDER BY 
         CASE WHEN deadline IS NOT NULL AND TRIM(deadline) != '' THEN 0 ELSE 1 END ASC, 
         deadline ASC, 
         id DESC`,
      [user.id]
    );

    if (!tasks || tasks.length === 0) {
      await sendVkMessage(
        fromId,
        `🎉 ${user.name}, у вас нет активных задач!\nВсе назначенные задачи закрыты или вы еще не взяли новую работу в контент-плане.`
      );
      return;
    }

    const now = new Date();
    const lines = [
      `📋 ВАШИ АКТИВНЫЕ ЗАДАЧИ (${tasks.length}):`,
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

      let deadlineInfo = '⏰ Срок: не установлен';
      if (t.deadline) {
        const dDate = new Date(t.deadline);
        const diffHours = (dDate - now) / (1000 * 60 * 60);
        const dateStr = t.deadline.replace('T', ' ');
        if (diffHours < 0) {
          deadlineInfo = `🔥 СРОК ПРОСРОЧЕН: ${dateStr}`;
        } else if (diffHours <= 48) {
          deadlineInfo = `⚡ ГОРИТ (осталось < ${Math.round(diffHours)} ч): ${dateStr}`;
        } else {
          deadlineInfo = `⏰ Дедлайн: ${dateStr}`;
        }
      }

      lines.push(`${i + 1}. #${t.id} «${t.title}»`);
      lines.push(`   ${statusIcon} Статус: ${statusName} | 🎯 Цех: ${t.direction}`);
      lines.push(`   ${deadlineInfo}`);
      if (t.rework_notes && t.status === 'rework') {
        lines.push(`   ⚠️ Замечания: ${t.rework_notes}`);
      }
      lines.push('');
    });

    lines.push('💡 Управление задачами (сдача файлов и ответы) доступно на веб-платформе.');
    await sendVkMessage(fromId, lines.join('\n'));
    return;
  }

  // Action 2: Urgent Deadlines (🔥 Горящие дедлайны)
  const isDeadlines = btnAction === 'urgent_deadlines' ||
                      cleanText.includes('дедлайн') ||
                      cleanText.includes('горящие') ||
                      cleanText === 'сроки' ||
                      cleanText === '/deadlines' ||
                      cleanText === 'deadlines' ||
                      cleanText.includes('горят');

  if (isDeadlines) {
    const tasks = await db.all(
      `SELECT * FROM tasks 
       WHERE assigned_to_id = ? AND status != 'done' AND deadline IS NOT NULL AND TRIM(deadline) != ''
       ORDER BY deadline ASC`,
      [user.id]
    );

    if (!tasks || tasks.length === 0) {
      await sendVkMessage(
        fromId,
        `✅ ${user.name}, у вас нет горящих дедлайнов!\nПо всем активным задачам сроки либо свободны, либо еще не назначены.`
      );
      return;
    }

    const now = new Date();
    const lines = [
      `🔥 ГОРЯЩИЕ ДЕДЛАЙНЫ (${tasks.length}):`,
      '━━━━━━━━━━━━━━━━━━'
    ];

    tasks.forEach((t, i) => {
      const dDate = new Date(t.deadline);
      const diffHours = (dDate - now) / (1000 * 60 * 60);
      const dateStr = t.deadline.replace('T', ' ');

      let tag = '⏰';
      if (diffHours < 0) tag = '🔥 ПРОСРОЧЕН:';
      else if (diffHours <= 24) tag = '⚡ ГОРИТ СЕГОДНЯ:';
      else if (diffHours <= 48) tag = '⚡ СРОЧНО (до 48ч):';

      lines.push(`${i + 1}. #${t.id} «${t.title}»`);
      lines.push(`   ${tag} ${dateStr}`);
      lines.push(`   Статус: ${t.status === 'rework' ? 'На доработке' : 'В работе'}`);
      lines.push('');
    });

    await sendVkMessage(fromId, lines.join('\n'));
    return;
  }

  // Action: Open / Available Tasks (🟢 Свободные задачи)
  const isOpenTasks = btnAction === 'open_tasks' ||
                      cleanText.includes('свободные') ||
                      cleanText.includes('открытые') ||
                      cleanText === '/open' ||
                      cleanText === 'open' ||
                      cleanText === 'взять задачу' ||
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
      await sendVkMessage(
        fromId,
        '🎉 В контент-плане сейчас нет свободных задач!\nВсе задачи уже распределены по участникам или успешно закрыты.'
      );
      return;
    }

    const now = new Date();
    const lines = [
      `🟢 СВОБОДНЫЕ ЗАДАЧИ В КОНТЕНТ-ПЛАНЕ (${openTasks.length}):`,
      '━━━━━━━━━━━━━━━━━━'
    ];

    openTasks.forEach((t, i) => {
      let deadlineInfo = '⏰ Срок: не установлен';
      if (t.deadline) {
        const dDate = new Date(t.deadline);
        const diffHours = (dDate - now) / (1000 * 60 * 60);
        const dateStr = t.deadline.replace('T', ' ');
        if (diffHours < 0) {
          deadlineInfo = `🔥 СРОК ПРОСРОЧЕН: ${dateStr}`;
        } else if (diffHours <= 48) {
          deadlineInfo = `⚡ ГОРИТ (осталось < ${Math.round(diffHours)} ч): ${dateStr}`;
        } else {
          deadlineInfo = `⏰ Дедлайн: ${dateStr}`;
        }
      }

      const isMyDir = (user && user.role === t.direction) ? ' ⭐ (Ваш цех!)' : '';
      lines.push(`${i + 1}. #${t.id} «${t.title}»${isMyDir}`);
      lines.push(`   🎯 Цех: ${t.direction}`);
      lines.push(`   ${deadlineInfo}`);
      if (t.description) {
        const descPreview = t.description.length > 80 ? t.description.substring(0, 77) + '...' : t.description;
        lines.push(`   📝 ТЗ: ${descPreview}`);
      }
      lines.push('');
    });

    lines.push('🚀 Чтобы взять задачу в работу, откройте Контент-план на сайте:');
    lines.push('http://localhost:8000/content-plan');
    await sendVkMessage(fromId, lines.join('\n'));
    return;
  }

  // Action 3: My Profile (👤 Мой профиль)
  const isProfile = btnAction === 'my_profile' ||
                    cleanText.includes('профиль') ||
                    cleanText === 'мой профиль' ||
                    cleanText === '/profile' ||
                    cleanText === '/me' ||
                    cleanText === 'статистика' ||
                    cleanText === 'мой аккаунт';

  if (isProfile) {
    const levelNames = {
      1: 'Участник актива',
      2: 'Глава направления',
      3: 'Руководитель медиацентра',
      4: 'Администратор системы'
    };

    const textProfile = [
      `👤 ПРОФИЛЬ: ${user.name}`,
      '━━━━━━━━━━━━━━━━━━',
      `Логин: @${user.username || 'нет'}`,
      `Цех: ${user.role}`,
      `Уровень: ${user.access_level} (${levelNames[user.access_level] || 'Участник'})`,
      `Выполнено задач: ${user.completed_tasks}`,
      `Средний балл: ${Number(user.average_score || 0).toFixed(1)} / 10.0`,
      `VK ID: ${fromId} (привязан)`,
      '━━━━━━━━━━━━━━━━━━',
      'Для отвязки отправьте: /unlink'
    ].join('\n');

    await sendVkMessage(fromId, textProfile);
    return;
  }

  // Action: Help / Default
  const helpText = [
    `Привет, ${user.name}! Вы в информационном боте Медиацентра ОСО СГТУ.`,
    '━━━━━━━━━━━━━━━━━━',
    '📌 Доступные команды (только просмотр):',
    '• 📋 «Мои задачи» — список ваших задач и их статусы',
    '• 🔥 «Горящие дедлайны» — сортировка ближайших сроков',
    '• 🟢 «Свободные задачи» — просмотр доступных задач в контент-плане',
    '• 👤 «Мой профиль» — статистика и рейтинг',
    '• 🔗 «/unlink» — отвязать страницу VK',
    '',
    'Бот работает в режиме мониторинга. Сдача материалов и проверка задач производятся через веб-платформу.'
  ].join('\n');

  await sendVkMessage(fromId, helpText);
  return;
}

// -------------------------------------------------------------
// Long Poll Polling Worker
// -------------------------------------------------------------

async function autoDetectGroupId() {
  try {
    const res = await callVkApi('groups.getById', {});
    if (res && res.groups && res.groups[0] && res.groups[0].id) {
      return String(res.groups[0].id);
    }
    if (Array.isArray(res) && res[0] && res[0].id) {
      return String(res[0].id);
    }
  } catch (e) {}
  return null;
}

class VkBotWorker {
  constructor() {
    this.isRunning = false;
    this.pollPromise = null;
    this.abortController = null;
  }

  start() {
    if (this.isRunning) return;
    const token = getGroupToken();

    if (!token) {
      console.log('[VkBot] VK Group Token не настроен. Бот ожидает настройки токена.');
      return;
    }

    this.isRunning = true;
    console.log('[VkBot] Запуск VK Long Poll worker...');
    this._runLoop();
  }

  stop() {
    this.isRunning = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    console.log('[VkBot] VK Long Poll worker остановлен.');
  }

  restart() {
    this.stop();
    setTimeout(() => {
      this.start();
    }, 1000);
  }

  async _runLoop() {
    let server = null;
    let key = null;
    let ts = null;

    while (this.isRunning) {
      const token = getGroupToken();
      let groupId = getGroupId();
      if (!token) {
        this.isRunning = false;
        break;
      }

      if (!groupId) {
        const detected = await autoDetectGroupId();
        if (detected) {
          groupId = detected;
          saveConfig({ vk_group_id: detected });
          console.log(`[VkBot] Автоматически определен Group ID: ${detected}`);
        }
      }

      if (!groupId) {
        console.log('[VkBot] Не указан и не определен VK Group ID. Ожидание настройки.');
        await new Promise(r => setTimeout(r, 10000));
        continue;
      }

      // Step 1: Obtain or refresh Long Poll server details
      if (!server || !key || !ts) {
        try {
          const lp = await callVkApi('groups.getLongPollServer', { group_id: groupId });
          if (!lp || !lp.server || !lp.key || !lp.ts) {
            // Wait 10 seconds before retrying
            await new Promise(r => setTimeout(r, 10000));
            continue;
          }
          server = lp.server;
          key = lp.key;
          ts = lp.ts;
          console.log('[VkBot] Long Poll подключен успешно. Ожидание событий...');
        } catch (e) {
          console.error('[VkBot] Ошибка получения Long Poll сервера:', e.message);
          await new Promise(r => setTimeout(r, 10000));
          continue;
        }
      }

      // Step 2: Poll server for new events
      try {
        const pollUrl = `${server}?act=a_check&key=${key}&ts=${ts}&wait=25`;
        const res = await fetch(pollUrl);
        const data = await res.json();

        if (data.failed) {
          if (data.failed === 1) {
            ts = data.ts;
          } else {
            // Key expired or ts lost, re-request server
            server = null;
            key = null;
            ts = null;
          }
          continue;
        }

        ts = data.ts;

        if (data.updates && Array.isArray(data.updates)) {
          for (const update of data.updates) {
            if (update.type === 'message_new') {
              const msg = update.object && update.object.message ? update.object.message : update.object;
              handleIncomingMessage(msg).catch(err => {
                console.error('[VkBot] Ошибка обработки сообщения:', err);
              });
            }
          }
        }
      } catch (err) {
        if (!this.isRunning) break;
        // Network timeout / disconnect
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }
}

const botWorker = new VkBotWorker();

module.exports = {
  getConfig,
  saveConfig,
  getGroupToken,
  getGroupId,
  autoDetectGroupId,
  resolveNumericUserId,
  callVkApi,
  sendVkMessage,
  getMainKeyboard,
  notifyTaskAssigned,
  notifyTaskForceAssigned,
  notifyNewOpenTask,
  notifyTaskRework,
  notifyTaskDeadlineChanged,
  handleIncomingMessage,
  botWorker
};
