const { get, run, ROOT_ADMIN_USERNAME } = require('./db');
const onlineTracker = require('./onlineTracker');

async function getCurrentUserMiddleware(req, res, next) {
  res.locals.current_user = null;
  req.user = null;
  res.locals.online_users = onlineTracker.getOnlineUsers();
  res.locals.online_user_ids = onlineTracker.getOnlineUserIds();
  res.locals.online_users_count = res.locals.online_users.length;

  const userId = req.cookies.user_id;
  if (!userId) {
    return next();
  }

  try {
    const uid = parseInt(userId, 10);
    if (isNaN(uid)) {
      return next();
    }

    const user = await get('SELECT * FROM users WHERE id = ?', [uid]);
    if (!user) {
      return next();
    }

    // stepyn is always root admin (level 4, approved)
    if (user.username === ROOT_ADMIN_USERNAME && (user.access_level !== 4 || !user.is_approved)) {
      user.access_level = 4;
      user.is_approved = 1;
      await run('UPDATE users SET access_level = 4, is_approved = 1 WHERE id = ?', [user.id]);
    }

    req.user = user;
    res.locals.current_user = user;
    onlineTracker.touchUser(user);

    // Update locals with current touched user included
    res.locals.online_users = onlineTracker.getOnlineUsers();
    res.locals.online_user_ids = onlineTracker.getOnlineUserIds();
    res.locals.online_users_count = res.locals.online_users.length;

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
  requireLevel
};
