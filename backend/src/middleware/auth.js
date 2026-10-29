import jwt from 'jsonwebtoken';
import { pool } from '../db.js';
import { config } from '../config.js';
import { ah, HttpError } from './errors.js';
import { loadEffectiveGrants } from '../permissions/grants.js';

export const signToken = (userId) => jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: config.jwtExpiry });

/** JWT only proves identity. User + grants are re-read from the DB on EVERY request, so revocations bite immediately. */
export const authenticate = ah(async (req, res, next) => {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) throw new HttpError(401, 'Missing bearer token');
  let payload;
  try { payload = jwt.verify(h.slice(7), config.jwtSecret); } catch { throw new HttpError(401, 'Invalid or expired token'); }
  const { rows: [user] } = await pool.query(
    'SELECT id, email, name, user_type, client_id, active FROM users WHERE id = $1 AND active', [payload.sub]);
  if (!user) throw new HttpError(401, 'User not found or deactivated');
  req.user = user;
  req.grants = await loadEffectiveGrants(pool, user.id);
  next();
});
