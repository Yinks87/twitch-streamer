import * as db from '../db.js';

export function getSessionToken(req) {
  const raw = req.headers.cookie || '';
  const m = raw.match(/(?:^|;\s*)session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

export function requireAuth(req, res, next) {
  const user = db.getUserBySession(getSessionToken(req));
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;
  next();
}
