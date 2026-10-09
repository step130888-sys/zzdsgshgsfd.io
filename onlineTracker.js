// onlineTracker.js - In-memory and DB tracking of active/online users in OCO SGTU Platform
const { run } = require('./db');

const ONLINE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes threshold for online presence
const DB_UPDATE_THROTTLE_MS = 2 * 60 * 1000; // Write to SQLite at most once per 2 minutes per user

// Map<number, { id, name, username, role, access_level, avatar_url, lastSeen, lastDbUpdate }>
const activeUsers = new Map();

/**
 * Record activity for an authenticated user
 */
function touchUser(user) {
  if (!user || !user.id) return;
  const now = Date.now();
  const existing = activeUsers.get(user.id);

  const shouldUpdateDb = !existing || !existing.lastDbUpdate || (now - existing.lastDbUpdate > DB_UPDATE_THROTTLE_MS);

  activeUsers.set(user.id, {
    id: user.id,
    name: user.name || 'Пользователь',
    username: user.username || '',
    role: user.role || 'Участник',
    access_level: user.access_level || 1,
    avatar_url: user.avatar_url || null,
    lastSeen: now,
    lastDbUpdate: shouldUpdateDb ? now : (existing ? existing.lastDbUpdate : now)
  });

  if (shouldUpdateDb) {
    const isoString = new Date(now).toISOString();
    run('UPDATE users SET last_seen_at = ? WHERE id = ?', [isoString, user.id]).catch((err) => {
      // Non-blocking background log
      console.error('[onlineTracker] Error updating last_seen_at in DB:', err.message);
    });
  }
}

/**
 * Check if a specific user is currently online
 */
function isUserOnline(userId) {
  if (!userId) return false;
  const uid = Number(userId);
  const entry = activeUsers.get(uid);
  if (!entry) return false;
  return (Date.now() - entry.lastSeen) <= ONLINE_WINDOW_MS;
}

/**
 * Returns array of currently online users
 */
function getOnlineUsers() {
  const now = Date.now();
  const list = [];

  for (const [id, data] of activeUsers.entries()) {
    const diff = now - data.lastSeen;
    if (diff <= ONLINE_WINDOW_MS) {
      let relativeTime = 'Только что';
      const minutesAgo = Math.floor(diff / 60000);
      if (minutesAgo >= 1) {
        relativeTime = `${minutesAgo} мин. назад`;
      }
      list.push({
        id: data.id,
        name: data.name,
        username: data.username,
        role: data.role,
        access_level: data.access_level,
        avatar_url: data.avatar_url,
        last_seen: data.lastSeen,
        relative_time: relativeTime
      });
    }
  }

  // Sort by access_level desc, then name asc
  list.sort((a, b) => {
    if (b.access_level !== a.access_level) {
      return b.access_level - a.access_level;
    }
    return a.name.localeCompare(b.name, 'ru');
  });

  return list;
}

/**
 * Returns an array of IDs of online users
 */
function getOnlineUserIds() {
  return getOnlineUsers().map(u => u.id);
}

/**
 * Formats a last_seen_at string/timestamp to human Russian text
 */
function formatLastSeen(dateVal) {
  if (!dateVal) return 'Неизвестно';
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return 'Неизвестно';

  const diffMs = Date.now() - d.getTime();
  if (diffMs <= ONLINE_WINDOW_MS) {
    return 'В сети';
  }

  const minutes = Math.floor(diffMs / (60 * 1000));
  if (minutes < 60) {
    return `Был(а) ${minutes} мин. назад`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const timeStr = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    return `Сегодня в ${timeStr}`;
  }

  const days = Math.floor(hours / 24);
  if (days === 1) {
    const timeStr = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    return `Вчера в ${timeStr}`;
  }

  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

module.exports = {
  ONLINE_WINDOW_MS,
  touchUser,
  isUserOnline,
  getOnlineUsers,
  getOnlineUserIds,
  formatLastSeen
};
