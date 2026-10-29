import { Router } from 'express';
import bcrypt from 'bcryptjs';   
import { pool } from '../db.js';
import { ah, HttpError } from '../middleware/errors.js';
import { authenticate, signToken } from '../middleware/auth.js';
import { loadNames, describeScope, isManager } from '../permissions/grants.js';

const r = Router();

r.post('/auth/login', ah(async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string') throw new HttpError(400, 'email and password required');
  const { rows: [u] } = await pool.query('SELECT id, email, name, user_type, password_hash, active FROM users WHERE lower(email) = lower($1)', [email]);
  const ok = u && u.active && await bcrypt.compare(password, u.password_hash);
  if (!ok) throw new HttpError(401, 'Invalid credentials');
  res.json({ token: signToken(u.id), user: { id: u.id, email: u.email, name: u.name, user_type: u.user_type } });
}));

// Demo-only helper for the login "switch user" dropdown (seeded accounts, not the scale users).
r.get('/auth/demo-users', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT email, name FROM users WHERE email LIKE '%@nfpl.test' AND email NOT LIKE '%@scale.nfpl.test' AND active ORDER BY id`);
  res.json(rows);
}));

// Staff directory for pickers (Why-panel, reassign). Managers only.
r.get('/users', authenticate, ah(async (req, res) => {
  if (!isManager(req.grants)) throw new HttpError(403, 'Managers only');
  const { rows } = await pool.query(`SELECT id, name, email FROM users WHERE active AND user_type = 'staff' ORDER BY name LIMIT 600`);
  res.json(rows);
}));

r.get('/me', authenticate, ah(async (req, res) => {
  const names = await loadNames(pool);
  res.json({
    user: req.user,
    is_manager: isManager(req.grants),
    can_manage_grants: req.grants.some((g) => g.source === 'own' && g.permissions.includes('grants.manage')),
    grants: req.grants.map((g) => ({
      id: g.id, role: g.role, source: g.source, delegator_id: g.delegator_id, scope: describeScope(g, names), permissions: g.permissions,
    })),
  });
}));

export default r;
