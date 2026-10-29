import { Router } from 'express';
import { pool } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { ah, HttpError } from '../middleware/errors.js';
import { can } from '../permissions/can.js';
import { audit } from '../services/audit.js';

const r = Router();
r.use(authenticate);

const FIELDS = ['client_id', 'branch_id', 'direction', 'mode'];

async function upsertOne(user, j) {
  if (typeof j?.ref !== 'string' || FIELDS.some((f) => j[f] == null)) return { ref: j?.ref, status: 400, error: `ref, ${FIELDS.join(', ')} required` };
  const meta = { actor_type: 'parser', ref: j.ref };
  const { rows: [existing] } = await pool.query('SELECT * FROM jobs WHERE ref = $1', [j.ref]);
  const target = { ...j }; // new scope
  // must be allowed on BOTH the current job (if any) and the requested scope
  for (const job of [existing, existing ? { ...existing, ...target } : { ...target, id: null, stage: null }].filter(Boolean)) {
    const d = await can(pool, user.id, 'upsert', job, {});
    if (!d.allowed) {
      await audit(pool, { actor: user.id, action: 'job.upsert', job: existing?.id, from: existing?.stage, decision: 'DENY', reason: d.reason, meta });
      return { ref: j.ref, status: 403, error: d.reason };
    }
  }
  if (existing) {
    const { rows: [u] } = await pool.query(
      `UPDATE jobs SET client_id = $2, branch_id = $3, direction = $4, mode = $5, internal_notes = COALESCE($6, internal_notes), updated_at = now()
       WHERE id = $1 AND stage <> 'Filed' RETURNING id, ref, stage`, [existing.id, j.client_id, j.branch_id, j.direction, j.mode, j.internal_notes ?? null]);
    if (!u) return { ref: j.ref, status: 403, error: 'Job is Filed' };
    await audit(pool, { actor: user.id, action: 'job.update', job: u.id, from: u.stage, decision: 'ALLOW', meta });
    return { ref: j.ref, status: 200, id: u.id, created: false };
  }
  const { rows: [c] } = await pool.query(
    `INSERT INTO jobs(ref, client_id, branch_id, direction, mode, stage, internal_notes) VALUES ($1,$2,$3,$4,$5,'Confirmed',$6) RETURNING id`,
    [j.ref, j.client_id, j.branch_id, j.direction, j.mode, j.internal_notes ?? null]);
  await audit(pool, { actor: user.id, action: 'job.create', job: c.id, to: 'Confirmed', decision: 'ALLOW', meta });
  return { ref: j.ref, status: 201, id: c.id, created: true };
}

// Accepts one job object or an array. The parser can only create/update (never move a job's stage) and never touches Filed jobs.
r.post('/jobs', ah(async (req, res) => {
  const items = Array.isArray(req.body) ? req.body : [req.body];
  if (!items.length || items.length > 500) throw new HttpError(400, 'Send 1-500 jobs');
  const results = [];
  for (const j of items) {
    try { results.push(await upsertOne(req.user, j)); }
    catch (e) { if (e.code === '23503' || e.code === '23514') results.push({ ref: j?.ref, status: 400, error: 'Invalid reference or value' }); else throw e; }
  }
  res.status(results.every((x) => x.status < 300) ? 200 : 207).json({ results });
}));

export default r;
