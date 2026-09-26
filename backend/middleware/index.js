import * as db from '../db/db.js';

export function getSessionToken(req) {
  const raw = req.headers.cookie || '';
  const m = raw.match(/(?:^|;\s*)session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function authenticate(req, res, next, requiredRoles) {
  const user = db.getUserBySession(getSessionToken(req));
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  console.log('Required roles:', requiredRoles);
  console.log('User role:', user.role);
  console.log('Authenticated user:', user);
  if (requiredRoles.length && !requiredRoles.includes(user.role)) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  req.user = user;
  next();
}

export function requireAuth(...args) {
  if (args.length === 3 && typeof args[2] === 'function') {
    return authenticate(args[0], args[1], args[2], []);
  }

  const requiredRoles = args.flat();
  return (req, res, next) => authenticate(req, res, next, requiredRoles);
}
