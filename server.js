const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const nunjucks = require('nunjucks');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const { getCurrentUserMiddleware, requireAuth, requireLevel, invalidateUserCache } = require('./auth');
const gdriveService = require('./gdriveService');
const telegramService = require('./telegramService');
const vkService = require('./vkService');
const onlineTracker = require('./onlineTracker');

// Polyfills for Jinja2 template compatibility
if (!String.prototype.startswith) {
  String.prototype.startswith = function (prefix) {
    return this.startsWith(prefix);
  };
}
if (!String.prototype.endswith) {
  String.prototype.endswith = function (suffix) {
    return this.endsWith(suffix);
  };
}
if (!String.prototype.strip) {
  String.prototype.strip = function () {
    return this.trim();
  };
}
if (!String.prototype.isdigit) {
  String.prototype.isdigit = function () {
    return /^\d+$/.test(this.trim());
  };
}
if (!String.prototype.lower) {
  String.prototype.lower = function () {
    return this.toLowerCase();
  };
}
if (!String.prototype.upper) {
  String.prototype.upper = function () {
    return this.toUpperCase();
  };
}
if (!Date.prototype.strftime) {
  Date.prototype.strftime = function (fmt) {
    const d = this.getDate().toString().padStart(2, '0');
    const m = (this.getMonth() + 1).toString().padStart(2, '0');
    const h = this.getHours().toString().padStart(2, '0');
    const min = this.getMinutes().toString().padStart(2, '0');
    return `${d}.${m} ${h}:${min}`;
  };
}
if (!String.prototype.strftime) {
  String.prototype.strftime = function (fmt) {
    const dt = new Date(this);
    if (isNaN(dt.getTime())) return this;
    return dt.strftime(fmt);
  };
}

function wrapDict(obj) {
  return new Proxy(obj || {}, {
    get(target, prop) {
      if (prop === 'get') {
        return (k, d = 0) => (target[k] !== undefined ? target[k] : d);
      }
      return target[prop];
    }
  });
}

const app = express();
const PORT = process.env.PORT || 8000;

// Setup Multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 } // 100 MB
});

// Configure Nunjucks with template caching for peak performance
const nunjucksEnv = nunjucks.configure(path.join(__dirname, 'templates'), {
  autoescape: true,
  express: app,
  noCache: process.env.NODE_ENV === 'development'
});

nunjucksEnv.addFilter('format', function (val, ...args) {
  // Case 1: Template writes "%.1f"|format(profile_user.average_score)
  if (typeof val === 'string' && val.includes('%')) {
    const rawVal = args.length > 0 ? args[0] : 0;
    const num = Number(rawVal);
    const safeNum = isNaN(num) ? 0 : num;
    if (val.includes('.1f')) return safeNum.toFixed(1);
    if (val.includes('.2f')) return safeNum.toFixed(2);
    if (val.includes('.0f') || val.includes('%d')) return Math.round(safeNum).toString();
    return safeNum.toString();
  }

  // Case 2: Template writes profile_user.average_score|format("%.1f")
  const num = Number(val);
  const safeNum = isNaN(num) ? 0 : num;
  const fmt = (args.length > 0 && args[0]) ? String(args[0]) : '';
  if (fmt.includes('.1f')) return safeNum.toFixed(1);
  if (fmt.includes('.2f')) return safeNum.toFixed(2);
  if (fmt.includes('.0f') || fmt.includes('%d')) return Math.round(safeNum).toString();

  if (typeof val === 'number') return safeNum.toFixed(1);
  return val != null ? String(val) : '';
});

nunjucksEnv.addFilter('round', function (val, precision = 0) {
  const num = Number(val);
  if (isNaN(num)) return 0;
  return Number(num.toFixed(precision));
});

nunjucksEnv.addFilter('selectattr', function (arr, attr, test, val) {
  if (!Array.isArray(arr)) return [];
  if (test === 'equalto') return arr.filter(item => item && item[attr] === val);
  if (test === 'in') return arr.filter(item => item && val.includes(item[attr]));
  return arr.filter(item => item && item[attr]);
});

nunjucksEnv.addFilter('formatLastSeen', function (val) {
  return onlineTracker.formatLastSeen(val);
});

nunjucksEnv.addFilter('isOnline', function (userId) {
  return onlineTracker.isUserOnline(userId);
});

// Middleware
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));
app.use(cookieParser());
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { maxAge: '1d' }));


// Attach current user & global template context
app.use(getCurrentUserMiddleware);
app.use((req, res, next) => {
  res.locals.request = {
    url: {
      path: req.path
    }
  };
  res.locals.error = req.query.error || null;
  res.locals.msg = req.query.msg || null;
  next();
});

// -------------------------------------------------------------
// Live Online Tracking API Endpoints
// -------------------------------------------------------------

app.get('/api/online-users', (req, res) => {
  if (req.user) {
    onlineTracker.touchUser(req.user);
  }
  const users = onlineTracker.getOnlineUsers();
  res.json({
    count: users.length,
    users
  });
});

app.post('/api/heartbeat', (req, res) => {
  if (req.user) {
    onlineTracker.touchUser(req.user);
  }
  const users = onlineTracker.getOnlineUsers();
  res.json({
    ok: true,
    count: users.length
  });
});


// -------------------------------------------------------------
// Public Student Council Portal (ОСО СГТУ)
// -------------------------------------------------------------

app.get('/oco', (req, res) => {
  res.redirect('/');
});

app.get('/', (req, res) => {
  if (req.user && req.user.is_approved) {
    return res.redirect('/content-plan');
  }
  return res.redirect('/login');
});

app.get('/login', (req, res) => {
  res.render('login.html', {
    current_user: req.user,
    error: req.query.error,
    msg: req.query.msg
  });
});

app.post('/login', async (req, res) => {
  const username = (req.body.username || '').trim().toLowerCase();
  const password = (req.body.password || '').trim();

  const user = await db.get('SELECT * FROM users WHERE LOWER(username) = ?', [username]);

  if (!user || !db.verifyPassword(password, user.password_hash)) {
    const err = encodeURIComponent('Неверный логин или пароль.');
    return res.redirect(`/login?error=${err}`);
  }

  if (!user.is_approved) {
    const err = encodeURIComponent(
      'Ваш профиль ожидает одобрения главным администратором (4 уровень). Доступ откроется после подтверждения.'
    );
    return res.redirect(`/login?error=${err}`);
  }

  res.cookie('user_id', String(user.id), {
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
  res.redirect('/content-plan');
});

app.get('/register', (req, res) => {
  res.render('register.html', {
    current_user: req.user,
    error: req.query.error,
    msg: req.query.msg
  });
});

app.post('/register', async (req, res) => {
  const name = (req.body.name || '').trim();
  const username = (req.body.username || '').trim().toLowerCase();
  const password = (req.body.password || '').trim();
  const role = (req.body.role || '').trim();
  const telegramId = (req.body.telegram_id || '').trim();

  if (!name || !username || !password || !role) {
    const err = encodeURIComponent('Все обязательные поля (ФИО, логин, пароль, направление) должны быть заполнены.');
    return res.redirect(`/register?error=${err}`);
  }

  const existing = await db.get('SELECT id FROM users WHERE LOWER(username) = ?', [username]);
  if (existing) {
    const err = encodeURIComponent(`Логин '${username}' уже занят. Пожалуйста, выберите другой логин.`);
    return res.redirect(`/register?error=${err}`);
  }

  const passwordHash = db.hashPassword(password);
  const result = await db.run(
    `INSERT INTO users (name, username, password_hash, telegram_id, role, access_level, is_approved, completed_tasks, average_score)
     VALUES (?, ?, ?, ?, ?, 1, 0, 0, 0.0)`,
    [name, username, passwordHash, telegramId || null, role]
  );

  const newUser = await db.get('SELECT * FROM users WHERE id = ?', [result.lastID]);
  try {
    await telegramService.notifyNewUserRegistered(newUser);
  } catch (e) {
    console.error('Error notifying new user registration:', e);
  }

  const msg = encodeURIComponent('Заявка успешно отправлена! Главный администратор (4 уровень) рассмотрит ее в специальной ветке модерации.');
  return res.redirect(`/login?msg=${msg}`);
});

app.get('/logout', (req, res) => {
  res.clearCookie('user_id');
  const msg = encodeURIComponent('Вы успешно вышли из системы.');
  res.redirect(`/login?msg=${msg}`);
});

// -------------------------------------------------------------
// Admin: User Management (Level 4)
// -------------------------------------------------------------

app.get('/admin/users', requireAuth, requireLevel(4, 'Доступ в ветку управления профилями разрешен только Администраторам (Уровень 4).'), async (req, res) => {
  const pendingUsers = await db.all('SELECT * FROM users WHERE is_approved = 0 ORDER BY id DESC');
  const activeUsers = await db.all('SELECT * FROM users WHERE is_approved = 1 ORDER BY access_level DESC, id ASC');

  res.render('admin_users.html', {
    current_user: req.user,
    pending_users: pendingUsers,
    active_users: activeUsers,
    error: req.query.error,
    msg: req.query.msg
  });
});

app.post('/admin/users/:id/approve', requireAuth, requireLevel(4), async (req, res) => {
  const profileId = parseInt(req.params.id, 10);
  const accessLevel = parseInt(req.body.access_level || 1, 10);

  const targetUser = await db.get('SELECT * FROM users WHERE id = ?', [profileId]);
  if (!targetUser) {
    const err = encodeURIComponent('Пользователь не найден.');
    return res.redirect(`/admin/users?error=${err}`);
  }

  const levelClamped = Math.max(1, Math.min(4, accessLevel));
  const canCreateTasks = (req.body.can_create_tasks === '1' || req.body.can_create_tasks === 'true' || req.body.can_create_tasks === 'on') ? 1 : 0;
  await db.run('UPDATE users SET is_approved = 1, access_level = ?, can_create_tasks = ? WHERE id = ?', [levelClamped, canCreateTasks, profileId]);
  invalidateUserCache(profileId);

  const msg = encodeURIComponent(`Профиль ${targetUser.name} (@${targetUser.username}) успешно одобрен с уровнем ${levelClamped}!`);
  res.redirect(`/admin/users?msg=${msg}`);
});

app.post('/admin/users/:id/reject', requireAuth, requireLevel(4), async (req, res) => {
  const profileId = parseInt(req.params.id, 10);
  const targetUser = await db.get('SELECT * FROM users WHERE id = ?', [profileId]);

  if (!targetUser) {
    const err = encodeURIComponent('Пользователь не найден.');
    return res.redirect(`/admin/users?error=${err}`);
  }

  if (targetUser.username === db.ROOT_ADMIN_USERNAME) {
    const err = encodeURIComponent("Системный профиль 'stepyn' защищен от любых изменений.");
    return res.redirect(`/admin/users?error=${err}`);
  }

  await db.run('DELETE FROM users WHERE id = ?', [profileId]);
  invalidateUserCache(profileId);
  const msg = encodeURIComponent('Заявка на регистрацию отклонена, временный профиль удален.');
  res.redirect(`/admin/users?msg=${msg}`);
});

app.post('/admin/users/:id/delete', requireAuth, requireLevel(4, 'Удалять профили могут только Администраторы (Уровень 4).'), async (req, res) => {
  const profileId = parseInt(req.params.id, 10);
  const targetUser = await db.get('SELECT * FROM users WHERE id = ?', [profileId]);

  if (!targetUser) {
    const err = encodeURIComponent('Пользователь не найден.');
    return res.redirect(`/admin/users?error=${err}`);
  }

  if (targetUser.username === db.ROOT_ADMIN_USERNAME) {
    const err = encodeURIComponent("ПРОФИЛЬ 'stepyn' ЯВЛЯЕТСЯ СИСТЕМНЫМ И ЗАЩИЩЕН ОТ УДАЛЕНИЯ НАВСЕГДА!");
    return res.redirect(`/admin/users?error=${err}`);
  }

  if (targetUser.id === req.user.id) {
    const err = encodeURIComponent('Вы не можете удалить свой собственный профиль во время активной сессии.');
    return res.redirect(`/admin/users?error=${err}`);
  }

  // Safe detachment of tasks
  await db.run('UPDATE tasks SET assigned_to_id = NULL, status = "open" WHERE assigned_to_id = ? AND status = "in_progress"', [profileId]);
  await db.run('UPDATE tasks SET assigned_to_id = NULL WHERE assigned_to_id = ?', [profileId]);
  await db.run('DELETE FROM users WHERE id = ?', [profileId]);
  invalidateUserCache(profileId);

  const msg = encodeURIComponent(`Профиль ${targetUser.name} (@${targetUser.username}) удален. Связанные задачи освобождены.`);
  res.redirect(`/admin/users?msg=${msg}`);
});

app.post('/admin/users/:id/toggle-task-creation', requireAuth, requireLevel(4, 'Только администраторы (4 уровень) могут менять права создания задач.'), async (req, res) => {
  const profileId = parseInt(req.params.id, 10);
  const targetUser = await db.get('SELECT * FROM users WHERE id = ?', [profileId]);
  if (!targetUser) {
    const err = encodeURIComponent('Пользователь не найден.');
    return res.redirect('/admin/users?error=' + err);
  }

  const newVal = targetUser.can_create_tasks ? 0 : 1;
  await db.run('UPDATE users SET can_create_tasks = ? WHERE id = ?', [newVal, profileId]);
  invalidateUserCache(profileId);
  const redirectTo = req.body.redirect_to || '/admin/users';
  const msg = encodeURIComponent(`Доступ к созданию задач в контент-плане для «${targetUser.name}» ${newVal ? 'включен ✅' : 'отключен ✕'}.`);
  res.redirect(`${redirectTo}?msg=${msg}`);
});

app.post('/admin/users/:id/inline-edit', requireAuth, requireLevel(4, 'Недостаточно прав. Только администраторы (4 уровень) могут редактировать участников.'), upload.single('avatar_file'), async (req, res) => {
  const profileId = parseInt(req.params.id, 10);
  const name = (req.body.name || '').trim();
  const password = (req.body.password || '').trim();
  const role = (req.body.role || '').trim();
  const accessLevel = req.body.access_level !== undefined ? parseInt(req.body.access_level, 10) : null;
  const redirectTo = req.body.redirect_to || '/admin/users';
  const avatarUrlInput = (req.body.avatar_url || '').trim();
  const removeAvatar = req.body.remove_avatar === '1' || req.body.remove_avatar === 'true';
  const canCreateTasks = (req.body.can_create_tasks === '1' || req.body.can_create_tasks === 'true' || req.body.can_create_tasks === 'on') ? 1 : 0;

  const targetUser = await db.get('SELECT * FROM users WHERE id = ?', [profileId]);
  if (!targetUser) {
    const err = encodeURIComponent('Пользователь не найден.');
    return res.redirect(`${redirectTo}?error=${err}`);
  }

  if (name) targetUser.name = name;
  if (password) targetUser.password_hash = db.hashPassword(password);
  if (role) targetUser.role = role;

  if (accessLevel !== null && !isNaN(accessLevel)) {
    if (targetUser.username === db.ROOT_ADMIN_USERNAME) {
      targetUser.access_level = 4;
    } else {
      targetUser.access_level = Math.max(1, Math.min(4, accessLevel));
    }
  }

  if (removeAvatar) {
    if (targetUser.avatar_url && targetUser.avatar_url.startsWith('/uploads/avatars/')) {
      try {
        const oldFilePath = path.join(__dirname, targetUser.avatar_url.replace(/^\//, ''));
        if (fs.existsSync(oldFilePath)) fs.unlinkSync(oldFilePath);
      } catch (e) {}
    }
    targetUser.avatar_url = null;
  } else if (req.file && req.file.buffer && req.file.buffer.length > 0) {
    const allowedExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const rawExt = path.extname(req.file.originalname).toLowerCase();
    const ext = allowedExts.includes(rawExt) ? rawExt : '.png';
    const filename = `avatar_${profileId}_${Date.now()}${ext}`;
    const avatarsDir = path.join(__dirname, 'uploads', 'avatars');
    if (!fs.existsSync(avatarsDir)) {
      fs.mkdirSync(avatarsDir, { recursive: true });
    }
    fs.writeFileSync(path.join(avatarsDir, filename), req.file.buffer);
    targetUser.avatar_url = `/uploads/avatars/${filename}`;
  } else if (avatarUrlInput) {
    targetUser.avatar_url = avatarUrlInput;
  }

  await db.run(
    'UPDATE users SET name = ?, password_hash = ?, role = ?, access_level = ?, avatar_url = ?, can_create_tasks = ? WHERE id = ?',
    [targetUser.name, targetUser.password_hash, targetUser.role, targetUser.access_level, targetUser.avatar_url, canCreateTasks, profileId]
  );
  invalidateUserCache(profileId);

  const msg = encodeURIComponent(`Данные участника ${targetUser.name} успешно обновлены!`);
  res.redirect(`${redirectTo}?msg=${msg}`);
});

// -------------------------------------------------------------
// Profile Routes
// -------------------------------------------------------------

app.get('/profile/:id', requireAuth, async (req, res) => {
  const profileId = parseInt(req.params.id, 10);
  const profileUser = await db.get('SELECT * FROM users WHERE id = ?', [profileId]);

  if (!profileUser) {
    const err = encodeURIComponent('Пользователь не найден.');
    return res.redirect(`/content-plan?error=${err}`);
  }

  // Single fast query for tasks + reviewer info + comment count (eliminates N+1 loop)
  const userTasks = await db.all(`
    SELECT t.*,
           g.name AS grader_name, g.role AS grader_role,
           COALESCE(tc.comment_count, 0) AS comment_count
    FROM tasks t
    LEFT JOIN users g ON t.graded_by_id = g.id
    LEFT JOIN (
      SELECT task_id, COUNT(*) AS comment_count
      FROM task_comments
      GROUP BY task_id
    ) tc ON t.id = tc.task_id
    WHERE t.assigned_to_id = ?
    ORDER BY t.id DESC
  `, [profileId]);

  let inProgressCount = 0;
  let reviewCount = 0;
  for (const t of userTasks) {
    if (t.graded_by_id && t.grader_name) {
      t.graded_by = { id: t.graded_by_id, name: t.grader_name, role: t.grader_role };
    } else {
      t.graded_by = null;
    }
    t.comments = { length: t.comment_count };
    if (t.status === 'in_progress') inProgressCount++;
    else if (t.status === 'review') reviewCount++;
  }

  let openTasksQuery = 'SELECT * FROM tasks WHERE status = "open"';
  const openTasksParams = [];
  if (req.user.access_level <= 2) {
    openTasksQuery += ' AND direction = ?';
    openTasksParams.push(profileUser.role);
  }
  openTasksQuery += ` ORDER BY 
    CASE WHEN deadline IS NOT NULL AND TRIM(deadline) != '' THEN 0 ELSE 1 END ASC,
    deadline ASC, id DESC`;
  const openTasks = await db.all(openTasksQuery, openTasksParams);

  res.render('profile.html', {
    profile_user: profileUser,
    current_user: req.user,
    user_tasks: userTasks,
    open_tasks: openTasks,
    in_progress_count: inProgressCount,
    review_count: reviewCount,
    is_online: onlineTracker.isUserOnline(profileUser.id),
    last_seen_formatted: onlineTracker.formatLastSeen(profileUser.last_seen_at),
    vk_config: vkService.getConfig(),
    gdrive_folder_url: gdriveService.getTargetFolderUrl(),
    error: req.query.error,
    msg: req.query.msg
  });

});

app.post('/profile/:id/assign-task', requireAuth, async (req, res) => {
  const targetUserId = parseInt(req.params.id, 10);
  const targetUser = await db.get('SELECT * FROM users WHERE id = ?', [targetUserId]);
  if (!targetUser) {
    const err = encodeURIComponent('Пользователь не найден.');
    return res.redirect(`/content-plan?error=${err}`);
  }

  if (req.user.access_level < 2 && !req.user.can_create_tasks) {
    const err = encodeURIComponent('Недостаточно прав. Принудительно выдавать задачи могут руководители, главы цехов или уполномоченные участники.');
    return res.redirect(`/profile/${targetUserId}?error=${err}`);
  }

  if (req.user.access_level <= 2 && targetUser.role !== req.user.role) {
    const err = encodeURIComponent(`Вы можете выдавать задачи только участникам своего направления (${req.user.role}).`);
    return res.redirect(`/profile/${targetUserId}?error=${err}`);
  }

  const taskId = parseInt(req.body.task_id, 10);
  const comment = (req.body.comment || '').trim();

  const task = await db.get('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!task) {
    const err = encodeURIComponent('Задача не найдена.');
    return res.redirect(`/profile/${targetUserId}?error=${err}`);
  }

  const oldAssigneeId = task.assigned_to_id;
  await db.run('UPDATE tasks SET assigned_to_id = ?, status = "in_progress" WHERE id = ?', [targetUserId, taskId]);
  task.assigned_to_id = targetUserId;
  task.status = 'in_progress';

  if (oldAssigneeId && oldAssigneeId !== targetUserId) {
    await db.recalculateUserStats(oldAssigneeId);
  }
  await db.recalculateUserStats(targetUserId);

  const nowIso = new Date().toISOString();
  let chatText = `⚡ Руководитель ${req.user.name} (${req.user.role}) принудительно выдал задачу сотруднику ${targetUser.name}.`;
  if (comment) chatText += `\n\n📌 Указание руководителя: ${comment}`;
  await db.run(
    'INSERT INTO task_comments (task_id, user_id, message, created_at) VALUES (?, ?, ?, ?)',
    [taskId, req.user.id, chatText, nowIso]
  );

  try {
    await vkService.notifyTaskForceAssigned(task, targetUser, req.user, comment);
  } catch (e) {}

  try {
    await telegramService.notifyTaskForceAssigned(task, targetUser, req.user, comment);
  } catch (e) {}

  const msg = encodeURIComponent(`Задача #${task.id} «${task.title}» успешно принудительно выдана сотруднику ${targetUser.name}!`);
  res.redirect(`/profile/${targetUserId}?msg=${msg}`);
});

app.post('/profile/:id/avatar', requireAuth, upload.single('avatar_file'), async (req, res) => {
  const profileId = parseInt(req.params.id, 10);
  const targetRedirect = req.body.redirect_to && req.body.redirect_to.trim() ? req.body.redirect_to.trim() : `/profile/${profileId}`;

  const isSelf = (req.user.id === profileId);
  const isAdmin = (req.user.access_level >= 4);

  if (!isSelf && !isAdmin) {
    const err = encodeURIComponent('Недостаточно прав. Принудительно менять фото чужого профиля может только администратор 4-го уровня.');
    return res.redirect(`${targetRedirect}?error=${err}`);
  }

  const targetUser = await db.get('SELECT * FROM users WHERE id = ?', [profileId]);
  if (!targetUser) {
    const err = encodeURIComponent('Пользователь не найден.');
    return res.redirect(`/content-plan?error=${err}`);
  }

  // Handle remove avatar
  if (req.body.remove_avatar === '1' || req.body.remove_avatar === 'true') {
    if (targetUser.avatar_url && targetUser.avatar_url.startsWith('/uploads/avatars/')) {
      try {
        const oldFilePath = path.join(__dirname, targetUser.avatar_url.replace(/^\//, ''));
        if (fs.existsSync(oldFilePath)) fs.unlinkSync(oldFilePath);
      } catch (e) {
        console.error('Error deleting old avatar:', e);
      }
    }
    await db.run('UPDATE users SET avatar_url = NULL WHERE id = ?', [profileId]);
    invalidateUserCache(profileId);
    const msg = encodeURIComponent(
      isSelf ? 'Ваше фото профиля успешно удалено.' : `Фото профиля участника «${targetUser.name}» удалено администратором.`
    );
    return res.redirect(`${targetRedirect}?msg=${msg}`);
  }

  let newAvatarUrl = null;

  // Handle uploaded file
  if (req.file && req.file.buffer && req.file.buffer.length > 0) {
    const allowedExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const rawExt = path.extname(req.file.originalname).toLowerCase();
    const ext = allowedExts.includes(rawExt) ? rawExt : '.png';
    const filename = `avatar_${profileId}_${Date.now()}${ext}`;
    const avatarsDir = path.join(__dirname, 'uploads', 'avatars');
    if (!fs.existsSync(avatarsDir)) {
      fs.mkdirSync(avatarsDir, { recursive: true });
    }
    if (targetUser.avatar_url && targetUser.avatar_url.startsWith('/uploads/avatars/')) {
      try {
        const oldFilePath = path.join(__dirname, targetUser.avatar_url.replace(/^\//, ''));
        if (fs.existsSync(oldFilePath)) fs.unlinkSync(oldFilePath);
      } catch (e) {}
    }
    fs.writeFileSync(path.join(avatarsDir, filename), req.file.buffer);
    newAvatarUrl = `/uploads/avatars/${filename}`;
  } else if (req.body.avatar_url && req.body.avatar_url.trim()) {
    newAvatarUrl = req.body.avatar_url.trim();
  }

  if (!newAvatarUrl) {
    const err = encodeURIComponent('Пожалуйста, выберите файл изображения или вставьте ссылку на фото.');
    return res.redirect(`${targetRedirect}?error=${err}`);
  }

  await db.run('UPDATE users SET avatar_url = ? WHERE id = ?', [newAvatarUrl, profileId]);
  invalidateUserCache(profileId);

  const msg = encodeURIComponent(
    isSelf
      ? 'Ваше фото профиля успешно обновлено!'
      : `Фото профиля участника «${targetUser.name}» успешно изменено администратором (4 уровень)!`
  );
  res.redirect(`${targetRedirect}?msg=${msg}`);
});

app.post('/profile/:id/edit', requireAuth, requireLevel(4, 'Недостаточно прав. Только администраторы (4 уровень) могут редактировать профили участников.'), upload.single('avatar_file'), async (req, res) => {
  const profileId = parseInt(req.params.id, 10);
  const name = (req.body.name || '').trim();
  const password = (req.body.password || '').trim();
  const role = (req.body.role || '').trim();
  const accessLevel = req.body.access_level !== undefined ? parseInt(req.body.access_level, 10) : null;
  const avatarUrlInput = (req.body.avatar_url || '').trim();
  const removeAvatar = req.body.remove_avatar === '1' || req.body.remove_avatar === 'true';
  const vkIdInput = req.body.vk_id !== undefined ? (req.body.vk_id || '').trim() : undefined;

  const targetUser = await db.get('SELECT * FROM users WHERE id = ?', [profileId]);
  if (!targetUser) {
    const err = encodeURIComponent('Пользователь не найден.');
    return res.redirect(`/content-plan?error=${err}`);
  }

  if (name) targetUser.name = name;
  if (password) targetUser.password_hash = db.hashPassword(password);
  if (role) targetUser.role = role;

  if (vkIdInput !== undefined) {
    if (vkIdInput) {
      const resolved = await vkService.resolveNumericUserId(vkIdInput);
      targetUser.vk_id = resolved ? String(resolved) : null;
    } else {
      targetUser.vk_id = null;
    }
  }

  if (accessLevel !== null && !isNaN(accessLevel)) {
    if (targetUser.username === db.ROOT_ADMIN_USERNAME) {
      targetUser.access_level = 4;
    } else {
      targetUser.access_level = Math.max(1, Math.min(4, accessLevel));
    }
  }

  // Handle avatar
  if (removeAvatar) {
    if (targetUser.avatar_url && targetUser.avatar_url.startsWith('/uploads/avatars/')) {
      try {
        const oldFilePath = path.join(__dirname, targetUser.avatar_url.replace(/^\//, ''));
        if (fs.existsSync(oldFilePath)) fs.unlinkSync(oldFilePath);
      } catch (e) {}
    }
    targetUser.avatar_url = null;
  } else if (req.file && req.file.buffer && req.file.buffer.length > 0) {
    const allowedExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const rawExt = path.extname(req.file.originalname).toLowerCase();
    const ext = allowedExts.includes(rawExt) ? rawExt : '.png';
    const filename = `avatar_${profileId}_${Date.now()}${ext}`;
    const avatarsDir = path.join(__dirname, 'uploads', 'avatars');
    if (!fs.existsSync(avatarsDir)) {
      fs.mkdirSync(avatarsDir, { recursive: true });
    }
    if (targetUser.avatar_url && targetUser.avatar_url.startsWith('/uploads/avatars/')) {
      try {
        const oldFilePath = path.join(__dirname, targetUser.avatar_url.replace(/^\//, ''));
        if (fs.existsSync(oldFilePath)) fs.unlinkSync(oldFilePath);
      } catch (e) {}
    }
    fs.writeFileSync(path.join(avatarsDir, filename), req.file.buffer);
    targetUser.avatar_url = `/uploads/avatars/${filename}`;
  } else if (avatarUrlInput) {
    targetUser.avatar_url = avatarUrlInput;
  }

  const canCreateTasks = req.body.can_create_tasks !== undefined
    ? ((req.body.can_create_tasks === '1' || req.body.can_create_tasks === 'true' || req.body.can_create_tasks === 'on') ? 1 : 0)
    : (targetUser.can_create_tasks || 0);

  await db.run(
    'UPDATE users SET name = ?, password_hash = ?, role = ?, access_level = ?, avatar_url = ?, vk_id = ?, can_create_tasks = ? WHERE id = ?',
    [targetUser.name, targetUser.password_hash, targetUser.role, targetUser.access_level, targetUser.avatar_url, targetUser.vk_id, canCreateTasks, profileId]
  );
  invalidateUserCache(profileId);

  const msg = encodeURIComponent(`Данные профиля «${targetUser.name}» успешно обновлены!`);
  res.redirect(`/profile/${profileId}?msg=${msg}`);
});

app.post('/profile/telegram-bind', requireAuth, async (req, res) => {
  const telegramId = (req.body.telegram_id || '').trim();
  await db.run('UPDATE users SET telegram_id = ? WHERE id = ?', [telegramId || null, req.user.id]);
  invalidateUserCache(req.user.id);
  const msg = encodeURIComponent('Telegram успешно сохранен в вашем профиле!');
  res.redirect(`/profile/${req.user.id}?msg=${msg}`);
});

app.post('/profile/vk-bind', requireAuth, async (req, res) => {
  let rawVk = (req.body.vk_id || '').trim();
  let vkId = null;

  if (rawVk) {
    const resolved = await vkService.resolveNumericUserId(rawVk);
    if (!resolved) {
      const err = encodeURIComponent(`Не удалось найти страницу ВКонтакте по ссылке или ID «${rawVk}». Проверьте ссылку.`);
      return res.redirect(`/profile/${req.user.id}?error=${err}`);
    }
    vkId = String(resolved);

    const existing = await db.get('SELECT id, name FROM users WHERE vk_id = ? AND id != ?', [vkId, req.user.id]);
    if (existing) {
      const err = encodeURIComponent(`Этот VK ID (${vkId}) уже привязан к аккаунту «${existing.name}».`);
      return res.redirect(`/profile/${req.user.id}?error=${err}`);
    }
  }

  await db.run('UPDATE users SET vk_id = ? WHERE id = ?', [vkId, req.user.id]);
  invalidateUserCache(req.user.id);
  const msg = encodeURIComponent(vkId ? `VK профиль (id${vkId}) успешно привязан!` : 'VK профиль успешно отвязан.');
  res.redirect(`/profile/${req.user.id}?msg=${msg}`);
});

// -------------------------------------------------------------
// Content Plan Helper & Routes
// -------------------------------------------------------------

async function getAssignableUsersFor(user) {
  const isLeader = (user.access_level >= 3);
  const isDirectLead = (user.access_level === 2 || (user.access_level === 1 && user.can_create_tasks));

  let sql = `
    SELECT u.*, COALESCE(tc.active_count, 0) AS active_tasks_count
    FROM users u
    LEFT JOIN (
      SELECT assigned_to_id, COUNT(*) AS active_count
      FROM tasks
      WHERE status IN ('in_progress', 'rework')
      GROUP BY assigned_to_id
    ) tc ON u.id = tc.assigned_to_id
    WHERE u.is_approved = 1
  `;
  const params = [];
  if (!isLeader && isDirectLead) {
    sql += ' AND u.role = ? ORDER BY u.name ASC';
    params.push(user.role);
  } else {
    sql += ' ORDER BY u.role ASC, u.name ASC';
  }
  return await db.all(sql, params);
}

app.get('/content-plan', requireAuth, async (req, res) => {
  const direction = req.query.direction ? req.query.direction.trim() : null;
  const status = req.query.status ? req.query.status.trim() : null;

  let query = `
    SELECT t.*,
           u.id AS u_id,
           u.name AS u_name,
           u.username AS u_username,
           u.role AS u_role,
           u.avatar_url AS u_avatar_url,
           u.access_level AS u_access_level,
           COALESCE(tc.comment_count, 0) AS comment_count
    FROM tasks t
    LEFT JOIN users u ON t.assigned_to_id = u.id
    LEFT JOIN (
      SELECT task_id, COUNT(*) AS comment_count
      FROM task_comments
      GROUP BY task_id
    ) tc ON t.id = tc.task_id
  `;
  const where = [];
  const params = [];

  if (direction) {
    where.push('t.direction = ?');
    params.push(direction);
  }
  if (status) {
    where.push('t.status = ?');
    params.push(status);
  }

  if (where.length > 0) {
    query += ' WHERE ' + where.join(' AND ');
  }
  query += ` ORDER BY 
    CASE 
      WHEN t.deadline IS NOT NULL AND TRIM(t.deadline) != '' THEN 0 
      ELSE 1 
    END ASC, 
    t.deadline ASC, 
    t.id DESC`;

  const tasks = await db.all(query, params);
  const now = new Date();
  for (const t of tasks) {
    t.assigned_to = t.assigned_to_id ? {
      id: t.u_id,
      name: t.u_name,
      username: t.u_username,
      role: t.u_role,
      avatar_url: t.u_avatar_url,
      access_level: t.u_access_level
    } : null;
    t.comments = { length: t.comment_count };

    if (t.deadline) {
      const dDate = new Date(t.deadline);
      const diffHours = (dDate - now) / (1000 * 60 * 60);
      t.is_expired = diffHours < 0;
      t.is_urgent = diffHours >= 0 && diffHours <= 48;
    } else {
      t.is_expired = false;
      t.is_urgent = false;
    }
  }

  const assignableUsers = await getAssignableUsersFor(req.user);

  res.render('content_plan.html', {
    current_user: req.user,
    tasks,
    selected_direction: direction,
    selected_status: status,
    assignable_users: assignableUsers,
    gdrive_folder_url: gdriveService.getTargetFolderUrl(),
    error: req.query.error,
    msg: req.query.msg
  });
});


app.post('/content-plan/create', requireAuth, async (req, res) => {
  if (req.user.access_level < 2 && !req.user.can_create_tasks) {
    const err = encodeURIComponent('Недостаточно прав. Создавать задачи могут только главы направлений, руководство или участники с персональным доступом.');
    return res.redirect(`/content-plan?error=${err}`);
  }

  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  const direction = (req.body.direction || '').trim() || req.user.role;
  const deadline = (req.body.deadline || '').trim() || null;
  const assignedToIdStr = (req.body.assigned_to_id || '').trim();
  const assigneeIdVal = assignedToIdStr ? parseInt(assignedToIdStr, 10) : null;

  // Level 1 or 2 restriction: can only assign within their direction
  if (req.user.access_level <= 2 && assigneeIdVal !== null) {
    const assignee = await db.get('SELECT * FROM users WHERE id = ?', [assigneeIdVal]);
    if (!assignee || assignee.role !== req.user.role) {
      const err = encodeURIComponent(`Ограничение: вы можете назначать задачи только участникам направления '${req.user.role}'.`);
      return res.redirect(`/content-plan?error=${err}`);
    }
  }

  const initialStatus = assigneeIdVal ? 'in_progress' : 'open';
  const result = await db.run(
    `INSERT INTO tasks (title, description, direction, status, deadline, assigned_to_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [title, description, direction, initialStatus, deadline, assigneeIdVal]
  );

  const createdTask = await db.get('SELECT * FROM tasks WHERE id = ?', [result.lastID]);
  if (assigneeIdVal) {
    const assignee = await db.get('SELECT * FROM users WHERE id = ?', [assigneeIdVal]);
    if (assignee) {
      try {
        await vkService.notifyTaskAssigned(createdTask, assignee);
      } catch (e) {
        console.error('Error notifying VK task assigned:', e);
      }
    }
  } else {
    try {
      await vkService.notifyNewOpenTask(createdTask);
    } catch (e) {
      console.error('Error notifying VK new open task:', e);
    }
  }

  const msg = encodeURIComponent(`Задача #${result.lastID} '${title}' успешно добавлена в контент-план.`);
  res.redirect(`/content-plan?msg=${msg}`);
});

// -------------------------------------------------------------
// Task Workflow & Comments Routes
// -------------------------------------------------------------

app.post('/task/:id/deadline', requireAuth, requireLevel(3, 'Недостаточно прав. Менять дедлайн задачи могут только руководители (3 и 4 уровень доступа).'), async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  const target = req.body.redirect_to && req.body.redirect_to.trim() ? req.body.redirect_to.trim() : '/content-plan';
  const deadline = (req.body.deadline || '').trim() || null;

  const task = await db.get('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!task) {
    const err = encodeURIComponent('Задача не найдена.');
    return res.redirect(`${target}?error=${err}`);
  }

  await db.run('UPDATE tasks SET deadline = ? WHERE id = ?', [deadline, taskId]);

  if (task.assigned_to_id) {
    const assignee = await db.get('SELECT * FROM users WHERE id = ?', [task.assigned_to_id]);
    if (assignee) {
      try {
        await vkService.notifyTaskDeadlineChanged(task, assignee, deadline);
      } catch (e) {
        console.error('Error notifying VK deadline change:', e);
      }
    }
  }

  const dlDisplay = deadline ? deadline.replace('T', ' ') : 'снят';
  const msg = encodeURIComponent(`Дедлайн по задаче #${task.id} успешно обновлен (${dlDisplay})!`);
  res.redirect(`${target}?msg=${msg}`);
});

app.get('/task/:id', requireAuth, async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  const task = await db.get(`
    SELECT t.*,
           u.id AS u_id, u.name AS u_name, u.role AS u_role, u.avatar_url AS u_avatar_url,
           g.id AS g_id, g.name AS g_name, g.role AS g_role
    FROM tasks t
    LEFT JOIN users u ON t.assigned_to_id = u.id
    LEFT JOIN users g ON t.graded_by_id = g.id
    WHERE t.id = ?
  `, [taskId]);

  if (!task) {
    const err = encodeURIComponent('Задача не найдена.');
    return res.redirect(`/content-plan?error=${err}`);
  }

  task.assigned_to = task.assigned_to_id ? {
    id: task.u_id,
    name: task.u_name,
    role: task.u_role,
    avatar_url: task.u_avatar_url
  } : null;

  task.graded_by = task.graded_by_id ? {
    id: task.g_id,
    name: task.g_name,
    role: task.g_role
  } : null;

  const rawComments = await db.all(`
    SELECT c.*,
           u.id AS u_id, u.name AS u_name, u.role AS u_role, u.avatar_url AS u_avatar_url, u.access_level AS u_access_level
    FROM task_comments c
    LEFT JOIN users u ON c.user_id = u.id
    WHERE c.task_id = ?
    ORDER BY c.id ASC
  `, [taskId]);

  for (const c of rawComments) {
    c.user = c.user_id ? {
      id: c.u_id,
      name: c.u_name,
      role: c.u_role,
      avatar_url: c.u_avatar_url,
      access_level: c.u_access_level
    } : null;
  }
  task.comments = rawComments;

  const assignableUsers = await getAssignableUsersFor(req.user);

  res.render('task_detail.html', {
    current_user: req.user,
    task,
    comments: rawComments,
    assignable_users: assignableUsers,
    gdrive_folder_url: gdriveService.getTargetFolderUrl(),
    error: req.query.error,
    msg: req.query.msg
  });
});


app.post('/task/:id/comments', requireAuth, async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  const message = (req.body.message || '').trim();
  const target = req.body.redirect_to && req.body.redirect_to.trim() ? req.body.redirect_to.trim() : `/task/${taskId}`;

  if (!message) {
    const err = encodeURIComponent('Сообщение не может быть пустым.');
    return res.redirect(`${target}?error=${err}#comments`);
  }

  const task = await db.get('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!task) {
    const err = encodeURIComponent('Задача не найдена.');
    return res.redirect(`/content-plan?error=${err}`);
  }

  const nowIso = new Date().toISOString();
  await db.run(
    'INSERT INTO task_comments (task_id, user_id, message, created_at) VALUES (?, ?, ?, ?)',
    [taskId, req.user.id, message, nowIso]
  );

  try {
    await telegramService.notifyTaskComment(task, req.user, message);
  } catch (e) {
    console.error('Error notifying comment in Telegram:', e);
  }

  const msg = encodeURIComponent('Сообщение успешно отправлено в чат задачи!');
  res.redirect(`${target}?msg=${msg}#comments`);
});

app.get('/api/task/:id/comments', requireAuth, async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  const task = await db.get('SELECT id, assigned_to_id FROM tasks WHERE id = ?', [taskId]);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const rawComments = await db.all(`
    SELECT c.id, c.user_id, c.message, c.created_at,
           u.name AS user_name, u.role AS user_role, u.access_level AS user_level, u.avatar_url AS user_avatar
    FROM task_comments c
    LEFT JOIN users u ON c.user_id = u.id
    WHERE c.task_id = ?
    ORDER BY c.id ASC
  `, [taskId]);

  const formatted = rawComments.map(c => ({
    id: c.id,
    user_id: c.user_id,
    user_name: c.user_name || 'Участник',
    user_role: c.user_role || '',
    user_level: c.user_level !== null && c.user_level !== undefined ? c.user_level : 1,
    user_avatar: c.user_avatar || null,
    message: c.message,
    created_at: c.created_at ? c.created_at.strftime('%d.%m %H:%M') : '',
    is_author_assignee: Boolean(task.assigned_to_id === c.user_id),
    is_current_user: Boolean(c.user_id === req.user.id)
  }));
  res.json(formatted);
});

app.post('/api/task/:id/comments', requireAuth, async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  const message = (req.body.message || '').trim();

  if (!message) {
    return res.status(400).json({ error: 'Empty message' });
  }

  const task = await db.get('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const nowIso = new Date().toISOString();
  const resInsert = await db.run(
    'INSERT INTO task_comments (task_id, user_id, message, created_at) VALUES (?, ?, ?, ?)',
    [taskId, req.user.id, message, nowIso]
  );

  try {
    await telegramService.notifyTaskComment(task, req.user, message);
  } catch (e) {
    console.error('Error notifying comment in Telegram:', e);
  }

  res.json({
    success: true,
    comment: {
      id: resInsert.lastID,
      user_id: req.user.id,
      user_name: req.user.name,
      user_role: req.user.role,
      user_level: req.user.access_level,
      user_avatar: req.user.avatar_url || null,
      message,
      created_at: nowIso.strftime('%d.%m %H:%M'),
      is_author_assignee: Boolean(task.assigned_to_id === req.user.id),
      is_current_user: true
    }
  });
});

app.post('/task/:id/take', requireAuth, async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  const task = await db.get('SELECT * FROM tasks WHERE id = ?', [taskId]);

  if (!task) {
    const err = encodeURIComponent('Задача не найдена.');
    return res.redirect(`/content-plan?error=${err}`);
  }

  if (task.status !== 'open') {
    const err = encodeURIComponent('Эта задача уже взята в работу другим участником или завершена.');
    return res.redirect(`/content-plan?error=${err}`);
  }

  await db.run('UPDATE tasks SET assigned_to_id = ?, status = "in_progress" WHERE id = ?', [req.user.id, taskId]);

  const msg = encodeURIComponent(`Вы успешно взяли задачу #${task.id} в работу! Ознакомьтесь с подробным описанием и задайте вопросы в чате.`);
  res.redirect(`/task/${task.id}?msg=${msg}`);
});

app.post(['/task/:id/assign', '/task/:id/force-assign'], requireAuth, async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  const target = req.body.redirect_to && req.body.redirect_to.trim() ? req.body.redirect_to.trim() : `/task/${taskId}`;
  const rawAssigneeId = (req.body.assigned_to_id !== undefined && req.body.assigned_to_id !== null) ? String(req.body.assigned_to_id).trim() : '';
  const comment = (req.body.comment || req.body.note || '').trim();

  // 1. Permission check:
  if (req.user.access_level < 2 && !req.user.can_create_tasks) {
    const err = encodeURIComponent('Недостаточно прав. Принудительно назначать задачи могут руководители, главы цехов или уполномоченные участники.');
    return res.redirect(`${target}?error=${err}`);
  }

  const task = await db.get('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!task) {
    const err = encodeURIComponent('Задача не найдена.');
    return res.redirect(`/content-plan?error=${err}`);
  }

  // Direction boundary check for level 1-2:
  if (req.user.access_level <= 2 && task.direction !== req.user.role) {
    const err = encodeURIComponent(`Вы можете управлять только задачами своего цеха (${req.user.role}).`);
    return res.redirect(`${target}?error=${err}`);
  }

  const oldAssigneeId = task.assigned_to_id;

  // Case A: Unassigning (making task open)
  if (!rawAssigneeId) {
    await db.run('UPDATE tasks SET assigned_to_id = NULL, status = "open" WHERE id = ?', [taskId]);
    if (oldAssigneeId) {
      await db.recalculateUserStats(oldAssigneeId);
    }

    const unassignMsg = `⚡ Руководитель ${req.user.name} (${req.user.role}) снял назначение исполнителя. Задача снова свободна (open).`;
    const nowIso = new Date().toISOString();
    await db.run(
      'INSERT INTO task_comments (task_id, user_id, message, created_at) VALUES (?, ?, ?, ?)',
      [taskId, req.user.id, unassignMsg, nowIso]
    );

    const msg = encodeURIComponent(`Назначение с задачи #${task.id} снято. Задача снова свободна в контент-плане.`);
    return res.redirect(`${target}?msg=${msg}`);
  }

  // Case B: Force assigning to a specific employee
  const newAssigneeId = parseInt(rawAssigneeId, 10);
  const newAssignee = await db.get('SELECT * FROM users WHERE id = ?', [newAssigneeId]);
  if (!newAssignee) {
    const err = encodeURIComponent('Выбранный сотрудник не найден.');
    return res.redirect(`${target}?error=${err}`);
  }

  if (!newAssignee.is_approved) {
    const err = encodeURIComponent('Нельзя назначить задачу неактивированному сотруднику (ожидает модерации).');
    return res.redirect(`${target}?error=${err}`);
  }

  if (req.user.access_level <= 2 && newAssignee.role !== req.user.role) {
    const err = encodeURIComponent(`Глава цеха может назначать задачи только участникам своего направления (${req.user.role}).`);
    return res.redirect(`${target}?error=${err}`);
  }

  const newStatus = (task.status === 'open') ? 'in_progress' : task.status;
  await db.run(
    'UPDATE tasks SET assigned_to_id = ?, status = ? WHERE id = ?',
    [newAssigneeId, newStatus, taskId]
  );
  task.assigned_to_id = newAssigneeId;
  task.status = newStatus;

  if (oldAssigneeId && oldAssigneeId !== newAssigneeId) {
    await db.recalculateUserStats(oldAssigneeId);
  }
  await db.recalculateUserStats(newAssigneeId);

  const nowIso = new Date().toISOString();
  let chatText = `⚡ Руководитель ${req.user.name} (${req.user.role}) принудительно выдал задачу сотруднику ${newAssignee.name} (@${newAssignee.username || 'user_' + newAssignee.id}).`;
  if (comment) {
    chatText += `\n\n📌 Указание руководителя: ${comment}`;
  }
  await db.run(
    'INSERT INTO task_comments (task_id, user_id, message, created_at) VALUES (?, ?, ?, ?)',
    [taskId, req.user.id, chatText, nowIso]
  );

  try {
    await vkService.notifyTaskForceAssigned(task, newAssignee, req.user, comment);
  } catch (e) {
    console.error('VK force-assign notification error:', e);
  }

  try {
    await telegramService.notifyTaskForceAssigned(task, newAssignee, req.user, comment);
  } catch (e) {
    console.error('Telegram force-assign notification error:', e);
  }

  const msg = encodeURIComponent(`Задача #${task.id} «${task.title}» успешно принудительно выдана сотруднику ${newAssignee.name}!`);
  return res.redirect(`${target}?msg=${msg}`);
});

app.post('/task/:id/submit', requireAuth, upload.single('file_upload'), async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  const fileLink = (req.body.file_link || '').trim();
  const target = req.body.redirect_to && req.body.redirect_to.trim() ? req.body.redirect_to.trim() : `/profile/${req.user.id}`;

  const task = await db.get('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!task) {
    const err = encodeURIComponent('Задача не найдена.');
    return res.redirect(`/content-plan?error=${err}`);
  }

  if (task.assigned_to_id !== req.user.id && req.user.access_level < 4) {
    const err = encodeURIComponent('Вы не можете сдать чужую задачу.');
    return res.redirect(`/content-plan?error=${err}`);
  }

  if (!['in_progress', 'open', 'rework'].includes(task.status)) {
    const err = encodeURIComponent('Задача уже находится на проверке или закрыта.');
    return res.redirect(`/profile/${req.user.id}?error=${err}`);
  }

  let resolvedLink = null;
  let resolvedName = null;

  // 1. If file uploaded
  if (req.file && req.file.buffer && req.file.buffer.length > 0) {
    const uploadRes = await gdriveService.saveLocalAndSyncGdrive(req.file.buffer, req.file.originalname, task.id);
    resolvedLink = uploadRes.fileLink;
    resolvedName = uploadRes.fileName;
  }

  // 2. If external link provided
  if (!resolvedLink && fileLink) {
    resolvedLink = fileLink;
    resolvedName = 'Внешняя ссылка';
  }

  if (!resolvedLink) {
    const err = encodeURIComponent('Пожалуйста, прикрепите файл или укажите ссылку на результат работы.');
    return res.redirect(`/profile/${req.user.id}?error=${err}`);
  }

  await db.run(
    'UPDATE tasks SET file_link = ?, file_name = ?, status = "review" WHERE id = ?',
    [resolvedLink, resolvedName, taskId]
  );
  task.file_link = resolvedLink;
  task.file_name = resolvedName;
  task.status = 'review';

  try {
    await telegramService.notifyTaskSubmittedForReview(task, req.user);
  } catch (e) {
    console.error('Error notifying task submission in Telegram:', e);
  }

  const msg = encodeURIComponent(`Работа по задаче #${task.id} успешно загружена и отправлена на проверку руководству!`);
  res.redirect(`${target}?msg=${msg}`);
});

app.post('/task/:id/rate', requireAuth, requireLevel(3, 'Оценивать задачи могут только руководители (Уровень 3–4).'), async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  const score = parseInt(req.body.score, 10);
  const target = req.body.redirect_to && req.body.redirect_to.trim() ? req.body.redirect_to.trim() : '/management';

  if (isNaN(score) || score < 1 || score > 10) {
    const err = encodeURIComponent('Оценка должна быть целым числом в диапазоне от 1 до 10.');
    return res.redirect(`/management?error=${err}`);
  }

  const task = await db.get('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!task) {
    const err = encodeURIComponent('Задача не найдена.');
    return res.redirect(`/management?error=${err}`);
  }

  await db.run(
    'UPDATE tasks SET score = ?, graded_by_id = ?, status = "done" WHERE id = ?',
    [score, req.user.id, taskId]
  );
  task.score = score;
  task.graded_by_id = req.user.id;
  task.status = 'done';

  await db.recalculateUserStats(task.assigned_to_id);

  try {
    await telegramService.notifyTaskGraded(task, req.user, score);
  } catch (e) {
    console.error('Error notifying task grade in Telegram:', e);
  }

  const msg = encodeURIComponent(`Задача #${task.id} принята с оценкой ${score}/10! Статистика исполнителя обновлена.`);
  res.redirect(`${target}?msg=${msg}`);
});

app.post('/task/:id/status', requireAuth, requireLevel(2, 'Недостаточно прав. Менять статус задач могут только руководители (Уровень 2, 3 и 4).'), async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  const targetStatus = (req.body.target_status || '').trim().toLowerCase();
  const score = req.body.score !== undefined ? parseInt(req.body.score, 10) : null;
  const reworkNotes = (req.body.rework_notes || '').trim();
  const target = req.body.redirect_to && req.body.redirect_to.trim() ? req.body.redirect_to.trim() : '/content-plan';

  const task = await db.get('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!task) {
    const err = encodeURIComponent('Задача не найдена.');
    return res.redirect(`${target}?error=${err}`);
  }

  const oldAssigneeId = task.assigned_to_id;

  if (targetStatus === 'done') {
    const finalScore = (score !== null && !isNaN(score) && score >= 1 && score <= 10) ? score : (task.score || 10);
    await db.run(
      'UPDATE tasks SET status = "done", score = ?, graded_by_id = ? WHERE id = ?',
      [finalScore, req.user.id, taskId]
    );
    task.score = finalScore;
    task.graded_by_id = req.user.id;
    task.status = 'done';

    await db.recalculateUserStats(oldAssigneeId);
    try {
      await telegramService.notifyTaskGraded(task, req.user, finalScore);
    } catch (e) {}

    const msg = encodeURIComponent(`Задача #${task.id} успешно закрыта как 'Выполнено' (оценка: ${finalScore}/10)!`);
    return res.redirect(`${target}?msg=${msg}`);
  } else if (targetStatus === 'in_progress') {
    await db.run(
      'UPDATE tasks SET status = "in_progress", score = NULL, graded_by_id = NULL WHERE id = ?',
      [taskId]
    );
    await db.recalculateUserStats(oldAssigneeId);

    const msg = encodeURIComponent(`Задача #${task.id} возвращена в статус 'В работе'.`);
    return res.redirect(`${target}?msg=${msg}`);
  } else if (targetStatus === 'rework') {
    await db.run(
      'UPDATE tasks SET status = "rework", score = NULL, graded_by_id = NULL, rework_notes = ? WHERE id = ?',
      [reworkNotes || null, taskId]
    );
    task.status = 'rework';
    task.rework_notes = reworkNotes;

    await db.recalculateUserStats(oldAssigneeId);
    try {
      await telegramService.notifyTaskRework(task, req.user, reworkNotes);
    } catch (e) {}

    if (oldAssigneeId) {
      const assignee = await db.get('SELECT * FROM users WHERE id = ?', [oldAssigneeId]);
      if (assignee) {
        try {
          await vkService.notifyTaskRework(task, assignee, reworkNotes);
        } catch (e) {}
      }
    }

    const msg = encodeURIComponent(`Задача #${task.id} отправлена на доработку. Исполнитель уведомлен!`);
    return res.redirect(`${target}?msg=${msg}`);
  } else {
    const err = encodeURIComponent(`Неизвестный целевой статус: ${targetStatus}`);
    return res.redirect(`${target}?error=${err}`);
  }
});

// -------------------------------------------------------------
// Management Panel Routes (Level 3-4)
// -------------------------------------------------------------

app.get('/management', requireAuth, requireLevel(3, 'Доступ к панели руководства ограничен (требуется уровень доступа 3 или 4).'), async (req, res) => {
  const reviewTasks = await db.all(`
    SELECT t.*, u.id AS u_id, u.name AS u_name, u.role AS u_role, u.avatar_url AS u_avatar_url
    FROM tasks t
    LEFT JOIN users u ON t.assigned_to_id = u.id
    WHERE t.status = 'review'
    ORDER BY t.id DESC
  `);
  for (const t of reviewTasks) {
    t.assigned_to = t.assigned_to_id ? { id: t.u_id, name: t.u_name, role: t.u_role, avatar_url: t.u_avatar_url } : null;
  }

  const doneTasksRow = await db.get('SELECT COUNT(*) as c FROM tasks WHERE status = "done"');
  const doneTasksCount = doneTasksRow ? doneTasksRow.c : 0;

  const teamMembers = await db.all('SELECT * FROM users WHERE is_approved = 1 ORDER BY access_level DESC, id ASC');
  const allTasks = await db.all(`
    SELECT t.*, g.name AS graded_by_name, g.role AS graded_by_role
    FROM tasks t
    LEFT JOIN users g ON t.graded_by_id = g.id
    ORDER BY t.id DESC
  `);
  const tasksByUserId = new Map();
  for (const t of allTasks) {
    if (t.graded_by_id) {
      t.graded_by = { id: t.graded_by_id, name: t.graded_by_name, role: t.graded_by_role };
    }
    const list = tasksByUserId.get(t.assigned_to_id);
    if (list) {
      list.push(t);
    } else {
      tasksByUserId.set(t.assigned_to_id, [t]);
    }
  }
  for (const member of teamMembers) {
    member.tasks = tasksByUserId.get(member.id) || [];
  }

  const avgRow = await db.get('SELECT ROUND(AVG(score), 2) AS avg_score FROM tasks WHERE status = "done" AND score IS NOT NULL');
  const teamAvgScore = avgRow && avgRow.avg_score != null ? avgRow.avg_score : 0.0;

  const pendingGdriveRow = await db.get('SELECT COUNT(*) as c FROM tasks WHERE file_link LIKE "/uploads/%"');
  const pendingGdriveCount = pendingGdriveRow ? pendingGdriveRow.c : 0;


  res.render('management.html', {
    current_user: req.user,
    review_tasks: reviewTasks,
    done_tasks_count: doneTasksCount,
    team_members: teamMembers,
    team_avg_score: teamAvgScore,
    bot_username: telegramService.getBotUsername(),
    leadership_chat_id: telegramService.getLeadershipChatId(),
    telegram_config: telegramService.getConfig(),
    vk_config: vkService.getConfig(),
    vk_bot_running: vkService.botWorker.isRunning,
    gdrive_folder_url: gdriveService.getTargetFolderUrl(),
    gdrive_info: gdriveService.getServiceAccountInfo(),
    pending_gdrive_count: pendingGdriveCount,
    apps_script_template: gdriveService.getAppsScriptTemplate(),
    error: req.query.error,
    msg: req.query.msg
  });
});

app.post('/management/telegram-config', requireAuth, requireLevel(3, 'Только руководство (Уровень 3+) может менять настройки Telegram бота.'), async (req, res) => {
  const proxyUrl = (req.body.proxy_url || '').trim();
  const apiBaseUrl = (req.body.api_base_url || '').trim() || 'https://api.telegram.org';

  telegramService.saveConfig({
    proxy_url: proxyUrl,
    api_base_url: apiBaseUrl
  });

  const msg = encodeURIComponent('Настройки сети Telegram (Прокси / Зеркало API) сохранены!');
  res.redirect(`/management?msg=${msg}`);
});

app.post('/management/telegram-test', requireAuth, requireLevel(3, 'Только руководство (Уровень 3+) может отправлять тестовые оповещения.'), async (req, res) => {
  const targetChat = (req.body.chat_id || '').trim() || req.user.telegram_id || telegramService.getLeadershipChatId();

  // Test network connectivity to Telegram API
  const testConn = await telegramService.testTelegramConnection();
  if (!testConn.ok) {
    const err = encodeURIComponent(`Связь с Telegram API недоступна: ${testConn.error}`);
    return res.redirect(`/management?error=${err}`);
  }

  if (!targetChat) {
    const msg = encodeURIComponent('✅ Связь с Telegram API работает штатно! Укажите Chat ID, чтобы отправить пробное сообщение.');
    return res.redirect(`/management?msg=${msg}`);
  }

  const ok = await telegramService.sendTestNotification(targetChat);
  if (ok) {
    const msg = encodeURIComponent(`Тестовое оповещение успешно доставлено в Telegram (${targetChat})!`);
    return res.redirect(`/management?msg=${msg}`);
  } else {
    const err = encodeURIComponent(`Не удалось отправить сообщение в '${targetChat}'. Проверьте, что бот @ping_sstu_bot запущен в диалоге или добавлен в группу.`);
    return res.redirect(`/management?error=${err}`);
  }
});

app.post('/management/telegram-set-group', requireAuth, requireLevel(3), (req, res) => {
  const cid = (req.body.group_chat_id || '').trim();
  telegramService.saveConfig({ leadership_group_chat_id: cid || null });
  const msg = encodeURIComponent(`Общий чат руководства (${cid || 'сброшен'}) успешно обновлен!`);
  res.redirect(`/management?msg=${msg}`);
});

app.post('/management/vk-config', requireAuth, requireLevel(3, 'Только руководство (Уровень 3+) может менять настройки VK бота.'), async (req, res) => {
  const token = (req.body.vk_group_token || '').trim();
  const groupId = (req.body.vk_group_id || '').trim();
  const isEnabled = req.body.is_enabled === 'on' || req.body.is_enabled === 'true' || req.body.is_enabled === '1';

  const updates = { is_enabled: isEnabled };
  if (token) updates.vk_group_token = token;
  if (groupId !== undefined) updates.vk_group_id = groupId;

  vkService.saveConfig(updates);

  if (isEnabled && (token || vkService.getGroupToken())) {
    vkService.botWorker.restart();
  } else {
    vkService.botWorker.stop();
  }

  const msg = encodeURIComponent('Настройки VK-бота успешно сохранены!');
  res.redirect(`/management?msg=${msg}`);
});

app.post('/management/vk-test', requireAuth, requireLevel(3, 'Только руководство (Уровень 3+) может отправлять тестовые VK оповещения.'), async (req, res) => {
  let targetVkInput = (req.body.vk_id || '').trim() || req.user.vk_id;
  if (!targetVkInput) {
    const err = encodeURIComponent('Укажите VK ID или ссылку на страницу для проверки.');
    return res.redirect(`/management?error=${err}`);
  }

  const numericId = await vkService.resolveNumericUserId(targetVkInput);
  if (!numericId) {
    const err = encodeURIComponent(`Не удалось найти страницу ВКонтакте: «${targetVkInput}». Проверьте ссылку или укажите цифровой ID.`);
    return res.redirect(`/management?error=${err}`);
  }

  const testMsg = [
    '🔔 ТЕСТОВОЕ ОПОВЕЩЕНИЕ СТУДСОВЕТА',
    '━━━━━━━━━━━━━━━━━━',
    'Интеграция с ботом ВКонтакте медиацентра ОСО СГТУ работает штатно!',
    'Вы будете получать мгновенные уведомления о назначенных задачах и дедлайнах.',
    '━━━━━━━━━━━━━━━━━━',
    '💡 Нажмите «📋 Мои задачи» или «🔥 Горящие дедлайны», чтобы проверить доступные команды.'
  ].join('\n');

  const ok = await vkService.sendVkMessage(numericId, testMsg);
  if (ok) {
    const msg = encodeURIComponent(`Тестовое оповещение успешно отправлено пользователю VK (ID: ${numericId})!`);
    res.redirect(`/management?msg=${msg}`);
  } else {
    const err = encodeURIComponent(`Не удалось отправить сообщение в VK (${numericId}). Убедитесь, что в группе включены «Возможности ботов» (Управление -> Сообщения -> Настройки для бота), а пользователь разрешил получение сообщений от группы.`);
    return res.redirect(`/management?error=${err}`);
  }
});

app.post('/management/gdrive/config', requireAuth, requireLevel(3, 'Только руководство (Уровень 3+) может менять настройки Google Диска.'), (req, res) => {
  const updates = {};
  if (req.body.webhook_url !== undefined) {
    updates.webhook_url = req.body.webhook_url.trim();
  }
  if (req.body.folder_id && req.body.folder_id.trim()) {
    const fId = req.body.folder_id.trim();
    updates.folder_id = fId;
    updates.folder_url = `https://drive.google.com/drive/folders/${fId}`;
  }

  gdriveService.saveGdriveConfig(updates);
  const msg = encodeURIComponent('Настройки интеграции с Google Диском успешно сохранены!');
  res.redirect(`/management?msg=${msg}`);
});

app.post('/management/gdrive/upload-sa', requireAuth, requireLevel(4, 'Только администраторы (Уровень 4) могут загружать ключ Service Account.'), upload.single('sa_file'), (req, res) => {
  if (!req.file || !req.file.buffer) {
    const err = encodeURIComponent('Файл не предоставлен.');
    return res.redirect(`/management?error=${err}`);
  }

  try {
    const parsed = JSON.parse(req.file.buffer.toString('utf8'));
    if (parsed.type !== 'service_account' || !parsed.client_email) {
      const err = encodeURIComponent('Файл не является валидным ключом Google Service Account JSON.');
      return res.redirect(`/management?error=${err}`);
    }

    fs.writeFileSync(gdriveService.SERVICE_ACCOUNT_FILE, req.file.buffer);
    const msg = encodeURIComponent(`Ключ Google Service Account (${parsed.client_email}) успешно сохранен!`);
    res.redirect(`/management?msg=${msg}`);
  } catch (e) {
    const err = encodeURIComponent(`Ошибка чтения файла ключа: ${e.message}`);
    res.redirect(`/management?error=${err}`);
  }
});

app.post('/management/gdrive/sync-all', requireAuth, requireLevel(3, 'Только руководство может запускать синхронизацию с Google Диском.'), async (req, res) => {
  const synced = await gdriveService.syncAllPendingTasks(db);
  if (synced > 0) {
    const msg = encodeURIComponent(`Успешно выгружено ${synced} файлов на Google Диск команды!`);
    res.redirect(`/management?msg=${msg}`);
  } else {
    const msg = encodeURIComponent('Нет файлов для выгрузки либо Google Диск (Webhook/Service Account) еще не настроен.');
    res.redirect(`/management?msg=${msg}`);
  }
});

// -------------------------------------------------------------
// Work Materials Repository Routes
// -------------------------------------------------------------

app.get('/materials', requireAuth, async (req, res) => {
  const direction = req.query.direction ? req.query.direction.trim() : null;
  const category = req.query.category ? req.query.category.trim() : null;

  let query = `
    SELECT m.*, u.id AS u_id, u.name AS u_name, u.role AS u_role, u.avatar_url AS u_avatar_url
    FROM work_materials m
    LEFT JOIN users u ON m.uploaded_by_id = u.id
  `;
  const where = [];
  const params = [];

  if (direction) {
    where.push('m.direction = ?');
    params.push(direction);
  }
  if (category) {
    where.push('m.category = ?');
    params.push(category);
  }

  if (where.length > 0) {
    query += ' WHERE ' + where.join(' AND ');
  }
  query += ' ORDER BY m.id DESC';

  const materials = await db.all(query, params);
  for (const m of materials) {
    m.uploaded_by = m.uploaded_by_id ? {
      id: m.u_id,
      name: m.u_name,
      role: m.u_role,
      avatar_url: m.u_avatar_url
    } : null;
  }

  const directionCounts = await db.all('SELECT direction, COUNT(*) as c FROM work_materials GROUP BY direction');
  const countsObj = {};
  let totalCount = 0;
  for (const row of directionCounts) {
    countsObj[row.direction] = row.c;
    totalCount += row.c;
  }

  res.render('materials.html', {
    current_user: req.user,
    materials,
    selected_direction: direction,
    selected_category: category,
    counts: wrapDict(countsObj),
    total_count: totalCount,
    gdrive_folder_url: gdriveService.getTargetFolderUrl(),
    error: req.query.error,
    msg: req.query.msg
  });
});


app.post('/materials/create', requireAuth, requireLevel(3, 'Недостаточно прав. Загружать материалы могут только руководители (3 и 4 уровень доступа).'), upload.single('file_upload'), async (req, res) => {
  const title = (req.body.title || '').trim();
  const direction = (req.body.direction || '').trim();
  const category = (req.body.category || 'Материалы').trim();
  const description = (req.body.description || '').trim() || null;
  const fileLink = (req.body.file_link || '').trim();

  if (!title) {
    const err = encodeURIComponent('Название материала не может быть пустым.');
    return res.redirect(`/materials?error=${err}`);
  }

  let resolvedLink = null;
  let resolvedName = null;

  // 1. If uploaded file
  if (req.file && req.file.buffer && req.file.buffer.length > 0) {
    const uploadRes = await gdriveService.saveLocalAndSyncGdrive(req.file.buffer, req.file.originalname, 999999);
    resolvedLink = uploadRes.fileLink;
    resolvedName = uploadRes.fileName;
  }

  // 2. If external link
  if (!resolvedLink && fileLink) {
    resolvedLink = fileLink;
    resolvedName = 'Внешняя ссылка';
  }

  if (!resolvedLink) {
    const err = encodeURIComponent('Пожалуйста, прикрепите файл или укажите ссылку на материал.');
    return res.redirect(`/materials?error=${err}`);
  }

  const nowIso = new Date().toISOString();
  await db.run(
    `INSERT INTO work_materials (title, description, direction, category, file_link, file_name, uploaded_by_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [title, description, direction, category, resolvedLink, resolvedName, req.user.id, nowIso]
  );

  const msg = encodeURIComponent(`Материал «${title}» успешно опубликован в разделе «${direction}»!`);
  res.redirect(`/materials?direction=${encodeURIComponent(direction)}&msg=${msg}`);
});

app.post('/materials/:id/delete', requireAuth, requireLevel(3, 'Недостаточно прав для удаления материалов.'), async (req, res) => {
  const materialId = parseInt(req.params.id, 10);
  const material = await db.get('SELECT * FROM work_materials WHERE id = ?', [materialId]);

  if (!material) {
    const err = encodeURIComponent('Материал не найден.');
    return res.redirect(`/materials?error=${err}`);
  }

  const title = material.title;
  await db.run('DELETE FROM work_materials WHERE id = ?', [materialId]);

  const msg = encodeURIComponent(`Материал «${title}» успешно удален.`);
  res.redirect(`/materials?msg=${msg}`);
});

// -------------------------------------------------------------
// Live Sync API
// -------------------------------------------------------------

app.get('/api/review-count', async (req, res) => {
  const row = await db.get('SELECT COUNT(*) as c FROM tasks WHERE status = "review"');
  res.json({ review_count: row.c });
});

// -------------------------------------------------------------
// Server Initialization
// -------------------------------------------------------------

async function startServer() {
  await db.initDb();
  console.log('[Database] SQLite initialized successfully.');

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 [Node.js Engine] Server running on http://0.0.0.0:${PORT}`);
    telegramService.botWorker.start();
    vkService.botWorker.start();
  });
}

if (require.main === module) {
  startServer().catch(err => {
    console.error('Server failed to start:', err);
  });
}

module.exports = { app, startServer };
