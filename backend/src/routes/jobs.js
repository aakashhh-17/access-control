import { Router } from 'express';
import { pool } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { ah, HttpError } from '../middleware/errors.js';
import { visibility, isManager, loadNames } from '../permissions/grants.js';
import { decide, can } from '../permissions/can.js';
import { ACTIONS, PUBLIC_ACTIONS } from '../permissions/actions.js';
import { listJobs, waitingCount } from '../queries/jobScope.js';
import { performAction } from '../services/jobActions.js';
import { whoCouldHave } from '../permissions/whoCouldHave.js';

const r = Router();
r.use(authenticate);

const JOB_SELECT = `
  SELECT j.*, c.name AS client_name, b.name AS branch_name,
         pu.name AS prepared_by_name, cu.name AS checked_by_name, fu.name AS filed_by_name, ru.name AS responsible_name
  FROM jobs j JOIN clients c ON c.id = j.client_id JOIN branches b ON b.id = j.branch_id
  LEFT JOIN users pu ON pu.id = j.prepared_by LEFT JOIN users cu ON cu.id = j.checked_by
  LEFT JOIN users fu ON fu.id = j.filed_by LEFT JOIN users ru ON ru.id = j.responsible_user_id`;

/** 404 (not 403) when the job is outside the caller's visibility, so existence is not leaked. */
async function loadVisibleJob(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(404, 'Job not found');
  const { rows: [job] } = await pool.query(`${JOB_SELECT} WHERE j.id = $1`, [id]);
  if (!job) throw new HttpError(404, 'Job not found');
  const vis = visibility(req.grants, job);
  if (!vis.visible) throw new HttpError(404, 'Job not found');
  return { job, vis };
}

r.get('/', ah(async (req, res) => {
  const view = req.query.view === 'waiting' ? 'waiting' : 'all';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const size = Math.min(100, Math.max(1, parseInt(req.query.page_size, 10) || 25));
  res.json(await listJobs(pool, req.grants, req.user.id, { view, page, size, q: String(req.query.q ?? '').trim().slice(0, 50) || undefined }));
}));

r.get('/waiting/count', ah(async (req, res) => {
  res.json({ count: await waitingCount(pool, req.grants, req.user.id) });
}));

r.get('/:id', ah(async (req, res) => {
  const { job, vis } = await loadVisibleJob(req);
  const names = await loadNames(pool);
  const { rows: [user] } = await pool.query('SELECT id, name, email, user_type, client_id, active FROM users WHERE id = $1', [req.user.id]);
  const actions = {};
  for (const a of [...PUBLIC_ACTIONS, 'reassign']) {
    const d = decide({ user, grants: req.grants, action: a, job, names });
    actions[a] = { allowed: d.allowed, reason: d.reason, matched_grant_id: d.matchedGrantId, requires_reason: !!ACTIONS[a].reason };
  }
  if (!vis.internal) delete job.internal_notes;
  res.json({ job, actions });
}));

r.post('/:id/actions', ah(async (req, res) => {
  const { action, reason, fix } = req.body || {};
  if (!PUBLIC_ACTIONS.includes(action)) throw new HttpError(400, `action must be one of ${PUBLIC_ACTIONS.join(', ')}`);
  res.json(await performAction(req.user.id, Number(req.params.id), action, { reason, fix }));
}));

r.post('/:id/reassign', ah(async (req, res) => {
  const { user_id, reason } = req.body || {};
  if (!Number.isInteger(user_id)) throw new HttpError(400, 'user_id (integer) required');
  res.json(await performAction(req.user.id, Number(req.params.id), 'reassign', { user_id, reason }));
}));

// "Why can she and he can't?" - any caller may ask about themselves; managers about anyone.
r.get('/:id/can', ah(async (req, res) => {
  const { job } = await loadVisibleJob(req);
  const target = req.query.user_id ? Number(req.query.user_id) : req.user.id;
  if (target !== req.user.id && !isManager(req.grants)) throw new HttpError(403, 'Only managers/admins can explain decisions for other users');
  const action = String(req.query.action ?? '');
  const result = await can(pool, target, action, job, { enforceReason: false });
  const { rows: [u] } = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [target]);
  res.json({ user: u ?? null, action, job_id: job.id, ...result });
}));

r.get('/:id/history', ah(async (req, res) => {
  const { job, vis } = await loadVisibleJob(req);
  const { rows } = await pool.query(
    `SELECT a.id, a.ts, a.actor_id, u.name AS actor_name, a.action, a.from_stage, a.to_stage, a.decision, a.reason, a.matched_grant_id, a.meta
     FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE a.job_id = $1 ORDER BY a.ts, a.id`, [job.id]);
  if (vis.internal) return res.json(rows);
  // client-side: stage movements only, no people, no reasons
  res.json(rows.filter((x) => x.decision === 'ALLOW' && x.to_stage).map((x) => ({ ts: x.ts, action: x.action, from_stage: x.from_stage, to_stage: x.to_stage })));
}));

r.get('/:id/who-could-have', ah(async (req, res) => {
  const { job } = await loadVisibleJob(req);
  if (!isManager(req.grants)) throw new HttpError(403, 'Managers/admins only');
  const date = String(req.query.date ?? '');
  let start; let end;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) { start = new Date(`${date}T00:00:00Z`); end = new Date(start.getTime() + 86400000); }
  else if (!Number.isNaN(Date.parse(date))) { start = new Date(date); end = new Date(start.getTime() + 1); }
  else throw new HttpError(400, 'date must be YYYY-MM-DD (UTC day) or an ISO timestamp');
  res.json({ job_id: job.id, window: { start, end }, ...(await whoCouldHave(pool, job, start, end)) });
}));

export default r;
