const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'media_app.db');
const db = new sqlite3.Database(DB_PATH);

// Helper functions for Promise-based SQL operations
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

const ROOT_ADMIN_USERNAME = 'stepyn';
const ROOT_ADMIN_DEFAULT_PASSWORD = '1111';

function hashPassword(password) {
  if (!password) return '';
  return crypto.createHash('sha256').update(password.trim()).digest('hex');
}

function verifyPassword(plainPassword, hashedPassword) {
  if (!plainPassword || !hashedPassword) return false;
  return hashPassword(plainPassword) === hashedPassword;
}

async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name VARCHAR(120) NOT NULL,
      username VARCHAR(100) UNIQUE,
      password_hash VARCHAR(255),
      telegram_id VARCHAR(64) UNIQUE,
      role VARCHAR(50) NOT NULL,
      access_level INTEGER NOT NULL DEFAULT 1,
      is_approved BOOLEAN NOT NULL DEFAULT 1,
      completed_tasks INTEGER NOT NULL DEFAULT 0,
      average_score FLOAT NOT NULL DEFAULT 0.0,
      avatar_url VARCHAR(500),
      vk_id VARCHAR(64) UNIQUE,
      can_create_tasks INTEGER NOT NULL DEFAULT 0
    )
  `);

  try {
    await run('ALTER TABLE users ADD COLUMN avatar_url VARCHAR(500)');
  } catch (e) {
    // Column already exists or table was just created with it
  }

  try {
    await run('ALTER TABLE users ADD COLUMN vk_id VARCHAR(64)');
  } catch (e) {
    // Column already exists or table was just created with it
  }

  try {
    await run('ALTER TABLE users ADD COLUMN can_create_tasks INTEGER NOT NULL DEFAULT 0');
  } catch (e) {
    // Column already exists
  }

  await run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title VARCHAR(200) NOT NULL,
      description TEXT NOT NULL,
      direction VARCHAR(50) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'open',
      assigned_to_id INTEGER,
      graded_by_id INTEGER,
      file_link VARCHAR(500),
      file_name VARCHAR(255),
      score INTEGER,
      deadline VARCHAR(50),
      rework_notes TEXT,
      FOREIGN KEY(assigned_to_id) REFERENCES users (id),
      FOREIGN KEY(graded_by_id) REFERENCES users (id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS task_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      message TEXT NOT NULL,
      created_at DATETIME NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks (id),
      FOREIGN KEY(user_id) REFERENCES users (id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS work_materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title VARCHAR(200) NOT NULL,
      description TEXT,
      direction VARCHAR(50) NOT NULL,
      category VARCHAR(50) NOT NULL DEFAULT 'Материалы',
      file_link VARCHAR(500) NOT NULL,
      file_name VARCHAR(255),
      uploaded_by_id INTEGER,
      created_at DATETIME NOT NULL,
      FOREIGN KEY(uploaded_by_id) REFERENCES users (id)
    )
  `);

  await ensureRootAdmin();
}

async function ensureRootAdmin() {
  let rootAdmin = await get('SELECT * FROM users WHERE username = ?', [ROOT_ADMIN_USERNAME]);
  if (!rootAdmin) {
    const passwordHash = hashPassword(ROOT_ADMIN_DEFAULT_PASSWORD);
    const res = await run(
      `INSERT INTO users (name, username, password_hash, telegram_id, role, access_level, is_approved, completed_tasks, average_score)
       VALUES (?, ?, ?, ?, ?, 4, 1, 0, 0.0)`,
      ['Степан (Главный Администратор)', ROOT_ADMIN_USERNAME, passwordHash, '@stepyn', 'Админ']
    );
    rootAdmin = await get('SELECT * FROM users WHERE id = ?', [res.lastID]);
    console.log(`[Security] Системный профиль '${ROOT_ADMIN_USERNAME}' (Уровень 4) успешно создан.`);
  } else {
    let updated = false;
    let newHash = rootAdmin.password_hash;
    let newLevel = rootAdmin.access_level;
    let newApproved = rootAdmin.is_approved;

    if (rootAdmin.access_level !== 4) {
      newLevel = 4;
      updated = true;
    }
    if (!rootAdmin.is_approved) {
      newApproved = 1;
      updated = true;
    }
    if (!rootAdmin.password_hash) {
      newHash = hashPassword(ROOT_ADMIN_DEFAULT_PASSWORD);
      updated = true;
    }
    if (updated) {
      await run(
        'UPDATE users SET access_level = 4, is_approved = 1, password_hash = ? WHERE id = ?',
        [newHash, rootAdmin.id]
      );
      console.log(`[Security] Системный профиль '${ROOT_ADMIN_USERNAME}' проверен: уровень 4 и статус подтверждены.`);
    }
  }
  return rootAdmin;
}

async function recalculateUserStats(userId) {
  if (!userId) return;
  const doneTasks = await all(
    'SELECT score FROM tasks WHERE assigned_to_id = ? AND status = "done" AND score IS NOT NULL',
    [userId]
  );
  const completedTasks = doneTasks.length;
  let averageScore = 0.0;
  if (completedTasks > 0) {
    const sum = doneTasks.reduce((acc, t) => acc + Number(t.score), 0);
    averageScore = Math.round((sum / completedTasks) * 100) / 100;
  }
  await run(
    'UPDATE users SET completed_tasks = ?, average_score = ? WHERE id = ?',
    [completedTasks, averageScore, userId]
  );
}

module.exports = {
  db,
  run,
  get,
  all,
  initDb,
  ensureRootAdmin,
  recalculateUserStats,
  hashPassword,
  verifyPassword,
  ROOT_ADMIN_USERNAME,
  ROOT_ADMIN_DEFAULT_PASSWORD
};
