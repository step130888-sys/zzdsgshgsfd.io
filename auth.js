const { get, run, ROOT_ADMIN_USERNAME, setUserCacheInvalidator } = require('./db');
const onlineTracker = require('./onlineTracker');

// High-speed user session in-memory cache (TTL: 15s)
const userCache = new Map();
const USER_CACHE_TTL_MS = 15000;

function invalidateUserCache(userId) {
  if (userId) {
    userCache.delete(Number(userId));
  } else {
    userCache.clear();
  }
}

if (typeof setUserCacheInvalidator === 'function') {
  setUserCacheInvalidator(invalidateUserCache);
}

function populateOnlineLocals(res) {
  const onlineList = onlineTracker.getOnlineUsers();
  res.locals.online_users = onlineList;
  res.locals.online_user_ids = onlineList.map(u => u.id);
  res.locals.online_users_count = onlineList.length;
}

async function getCurrentUserMiddleware(req, res, next) {
  res.locals.current_user = null;
  req.user = null;

  const userId = req.cookies.user_id;
  if (!userId) {
    populateOnlineLocals(res);
    return next();
  }

  try {
    const uid = parseInt(userId, 10);
    if (isNaN(uid)) {
      populateOnlineLocals(res);
      return next();
    }

    const now = Date.now();
    let user = null;
    const cached = userCache.get(uid);
    if (cached && cached.expiresAt > now) {
      user = cached.user;
    } else {
      user = await get('SELECT * FROM users WHERE id = ?', [uid]);
      if (user) {
        // stepyn is always root admin (level 4, approved)
        if (user.username === ROOT_ADMIN_USERNAME && (user.access_level !== 4 || !user.is_approved)) {
          user.access_level = 4;
          user.is_approved = 1;
          await run('UPDATE users SET access_level = 4, is_approved = 1 WHERE id = ?', [user.id]);
        }
        userCache.set(uid, { user, expiresAt: now + USER_CACHE_TTL_MS });
      }
    }

    if (!user) {
      populateOnlineLocals(res);
      return next();
    }

    req.user = user;
    res.locals.current_user = user;
    onlineTracker.touchUser(user);

    populateOnlineLocals(res);
    next();
  } catch (err) {
    console.error('Error in getCurrentUserMiddleware:', err);
    next();
  }
}



function requireAuth(req, res, next) {
  if (!req.user) {
    const err = encodeURIComponent('Пожалуйста, войдите в систему.');
    return res.redirect(`/login?error=${err}`);
  }
  if (!req.user.is_approved) {
    const err = encodeURIComponent('Ваш профиль ожидает одобрения администратором (4 уровень).');
    return res.redirect(`/login?error=${err}`);
  }
  next();
}

function requireLevel(minLevel, errorMsg = 'Недостаточно прав.') {
  return (req, res, next) => {
    if (!req.user || req.user.access_level < minLevel) {
      const err = encodeURIComponent(errorMsg);
      return res.redirect(`/content-plan?error=${err}`);
    }
    next();
  };
}

module.exports = {
  getCurrentUserMiddleware,
  requireAuth,
  requireLevel,
  invalidateUserCache
};

