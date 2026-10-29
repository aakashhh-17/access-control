import { Router } from 'express';
import { pool } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { ah, HttpError } from '../middleware/errors.js';
import { covers, hasPerm, DIMS } from '../permissions/grants.js';
import { audit } from '../services/audit.js';

const r = Router();
r.use(authenticate);

const need = (req) => { if (!hasPerm(req.grants, 'grants.manage')) throw new HttpError(403, 'grants.manage required'); };
const myManageGrants = (req) => req.grants.filter((g) => g.source === 'own' && g.permissions.includes('grants.manage'));

async function deny(req, action, reason, meta) {
  await audit(pool, { actor: req.user.id, action, decision: 'DENY', reason, meta });
  throw new HttpError(403, reason);
}

/** May the caller hand out / take back `role` over `scope`? Needs a grants.manage grant that lists the role AND covers the scope. */
const mayManage = (req, role, scope) => myManageGrants(req).find((g) => g.grantable_roles.includes(role) && covers(g, scope));

r.get('/meta', ah(async (req, res) => {
  need(req);
  const [roles, clients, branches, users] = await Promise.all([
    pool.query('SELECT name, description, permissions FROM roles ORDER BY name'),
    pool.query('SELECT id, name FROM clients ORDER BY name'),
    pool.query('SELECT id, name FROM branches ORDER BY name'),
    pool.query(`SELECT id, name, email, user_type FROM users WHERE active ORDER BY id LIMIT 600`),
  ]);
  const grantable = [...new Set(myManageGrants(req).flatMap((g) => g.grantable_roles))];
  res.json({ roles: roles.rows, grantable_roles: grantable, clients: clients.rows, branches: branches.rows, users: users.rows });
}));

r.get('/', ah(async (req, res) => {
  need(req);
  const params = [];
  const where = [];
  if (req.query.user_id) where.push(`g.user_id = $${params.push(Number(req.query.user_id))}`);
  if (req.query.active === '1') where.push(`g.revoked_at IS NULL AND (g.valid_to IS NULL OR g.valid_to > now()) AND g.valid_from <= now()`);
  const { rows } = await pool.query(
    `SELECT g.*, u.name AS user_name, u.email AS user_email, c.name AS client_name, b.name AS branch_name, cb.name AS created_by_name,
            CASE WHEN g.revoked_at IS NOT NULL THEN 'revoked' WHEN g.valid_to IS NOT NULL AND g.valid_to <= now() THEN 'expired'
                 WHEN g.valid_from > now() THEN 'scheduled' ELSE 'active' END AS status
     FROM grants g JOIN users u ON u.id = g.user_id LEFT JOIN clients c ON c.id = g.client_id LEFT JOIN branches b ON b.id = g.branch_id
     LEFT JOIN users cb ON cb.id = g.created_by
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY g.id DESC LIMIT 500`, params);
  // a manager only sees grants inside the slice they manage
  const mine = myManageGrants(req);
  res.json(rows.filter((g) => mine.some((m) => covers(m, g))));
}));

r.post('/', ah(async (req, res) => {
  need(req);
  const b = req.body || {};
  const scope = { client_id: b.client_id ?? null, branch_id: b.branch_id ?? null, direction: b.direction ?? null, mode: b.mode ?? null };
  const meta = { target_user: b.user_id, role: b.role, scope };
  if (!Number.isInteger(b.user_id) || typeof b.role !== 'string') throw new HttpError(400, 'user_id (integer) and role required');

  if (b.user_id === req.user.id) await deny(req, 'grant.create', 'Self-escalation blocked: you cannot grant roles to yourself', { ...meta, attempted: true });

  const { rows: [role] } = await pool.query('SELECT name FROM roles WHERE name = $1', [b.role]);
  if (!role) throw new HttpError(400, `Unknown role "${b.role}"`);
  const via = mayManage(req, b.role, scope);
  if (!via) await deny(req, 'grant.create', `Role ${b.role} over this scope is outside your grantable set`, meta);

  const { rows: [target] } = await pool.query('SELECT id, user_type, client_id, active FROM users WHERE id = $1', [b.user_id]);
  if (!target || !target.active) throw new HttpError(400, 'Target user not found or inactive');
  if (b.role === 'ClientUser' ? (target.user_type !== 'client' || scope.client_id !== target.client_id)
    : b.role === 'Parser' ? target.user_type !== 'service' : target.user_type !== 'staff') {
    throw new HttpError(400, `Role ${b.role} does not fit this user (type ${target.user_type})`);
  }
  const from = b.valid_from ? new Date(b.valid_from) : new Date();
  const to = b.valid_to ? new Date(b.valid_to) : null;
  if (Number.isNaN(+from) || (to && (Number.isNaN(+to) || to <= from))) throw new HttpError(400, 'Invalid validity window');

  const { rows: [g] } = await pool.query(
    `INSERT INTO grants(user_id, role, client_id, branch_id, direction, mode, valid_from, valid_to, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [b.user_id, b.role, ...DIMS.map((d) => scope[d]), from, to, req.user.id]);
  await audit(pool, { actor: req.user.id, action: 'grant.create', decision: 'ALLOW', grant: via.id, meta: { ...meta, grant_id: g.id } });
  res.status(201).json(g);
}));

r.post('/:id/revoke', ah(async (req, res) => {
  need(req);
  const { rows: [g] } = await pool.query('SELECT * FROM grants WHERE id = $1', [Number(req.params.id)]);
  if (!g) throw new HttpError(404, 'Grant not found');
  const meta = { grant_id: g.id, target_user: g.user_id, role: g.role };
  if (!mayManage(req, g.role, g)) await deny(req, 'grant.revoke', `Role ${g.role} over this scope is outside your grantable set`, meta);
  const { rows: [done] } = await pool.query(
    'UPDATE grants SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING *', [g.id, req.user.id]);
  if (!done) throw new HttpError(409, 'Grant already revoked');
  await audit(pool, { actor: req.user.id, action: 'grant.revoke', decision: 'ALLOW', grant: g.id, meta });
  res.json(done);
}));

export default r;
