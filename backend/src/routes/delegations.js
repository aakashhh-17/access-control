import { Router } from 'express';
import { pool } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { ah, HttpError } from '../middleware/errors.js';
import { isManager } from '../permissions/grants.js';
import { audit } from '../services/audit.js';

const r = Router();
r.use(authenticate);

// A delegation stores NO permissions. At decision time the delegate gets the delegator's *current* grants
// (minus admin powers, intersected with the optional scope), so it can never exceed what the delegator holds
// and shrinks automatically if the delegator's grants are revoked.
r.post('/', ah(async (req, res) => {
  const b = req.body || {};
  const from_user = b.from_user ?? req.user.id;
  if (!Number.isInteger(from_user) || !Number.isInteger(b.to_user)) throw new HttpError(400, 'from_user and to_user (integers) required');
  if (from_user !== req.user.id && !isManager(req.grants)) {
    await audit(pool, { actor: req.user.id, action: 'delegation.create', decision: 'DENY', reason: 'Only the delegator or a manager can create a delegation', meta: b });
    throw new HttpError(403, 'Only the delegator or a manager can create a delegation');
  }
  if (from_user === b.to_user) throw new HttpError(400, 'Cannot delegate to yourself');
  const to = new Date(b.valid_to); const from = b.valid_from ? new Date(b.valid_from) : new Date();
  if (Number.isNaN(+to) || Number.isNaN(+from) || to <= from) throw new HttpError(400, 'valid_to must be after valid_from');
  const { rows: [t] } = await pool.query(`SELECT id FROM users WHERE id = $1 AND active AND user_type = 'staff'`, [b.to_user]);
  if (!t) throw new HttpError(400, 'Delegate must be an active staff member');
  const { rows: [d] } = await pool.query(
    `INSERT INTO delegations(from_user, to_user, valid_from, valid_to, scope_client_id, scope_branch_id, reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [from_user, b.to_user, from, to, b.scope_client_id ?? null, b.scope_branch_id ?? null, b.reason ?? null, req.user.id]);
  await audit(pool, { actor: req.user.id, action: 'delegation.create', decision: 'ALLOW', meta: { delegation_id: d.id, from_user, to_user: b.to_user } });
  res.status(201).json(d);
}));

r.get('/', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT d.*, fu.name AS from_name, tu.name AS to_name FROM delegations d JOIN users fu ON fu.id = d.from_user JOIN users tu ON tu.id = d.to_user
     WHERE $2 OR d.from_user = $1 OR d.to_user = $1 ORDER BY d.id DESC LIMIT 200`, [req.user.id, isManager(req.grants)]);
  res.json(rows);
}));

r.post('/:id/revoke', ah(async (req, res) => {
  const { rows: [d] } = await pool.query('SELECT * FROM delegations WHERE id = $1', [Number(req.params.id)]);
  if (!d) throw new HttpError(404, 'Delegation not found');
  if (d.from_user !== req.user.id && !isManager(req.grants)) throw new HttpError(403, 'Not allowed');
  const { rows: [done] } = await pool.query('UPDATE delegations SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING *', [d.id]);
  if (!done) throw new HttpError(409, 'Already revoked');
  await audit(pool, { actor: req.user.id, action: 'delegation.revoke', decision: 'ALLOW', meta: { delegation_id: d.id } });
  res.json(done);
}));

export default r;
