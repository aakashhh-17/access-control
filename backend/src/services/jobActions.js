import { pool } from '../db.js';
import { can } from '../permissions/can.js';
import { ACTIONS } from '../permissions/actions.js';
import { HttpError } from '../middleware/errors.js';
import { audit } from './audit.js';

const FIX_STAGES = ['Confirmed', 'Prepared', 'Checked'];
const CLEAR = {
  Confirmed: 'prepared_by = NULL, checked_by = NULL, filed_by = NULL',
  Prepared: 'checked_by = NULL, filed_by = NULL',
  Checked: 'filed_by = NULL',
};

async function activeStaff(db, id) {
  const { rows: [u] } = await db.query(`SELECT id FROM users WHERE id = $1 AND active AND user_type = 'staff'`, [id]);
  if (!u) throw new HttpError(400, 'Target user must be an active staff member');
}

/**
 * Run one action atomically: lock job -> can() -> update -> audit (ALLOW or DENY).
 * Grants are read inside the same transaction, so a revocation committed a moment ago is already in force.
 */
export async function performAction(actorId, jobId, action, body = {}) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows: [job] } = await db.query('SELECT * FROM jobs WHERE id = $1 FOR UPDATE', [jobId]);
    if (!job) throw new HttpError(404, 'Job not found');

    const res = await can(db, actorId, action, job, { reason: body.reason, enforceReason: true });
    if (!res.allowed) {
      await audit(db, { actor: actorId, action, job: job.id, from: job.stage, decision: 'DENY', reason: res.reason,
        meta: { failed: res.checks.filter((c) => !c.pass).map((c) => c.name), attempted_reason: body.reason ?? null } });
      await db.query('COMMIT');
      throw new HttpError(403, res.reason, { result: res });
    }

    const def = ACTIONS[action];
    const meta = {};
    let to = def.to ?? null;
    switch (action) {
      case 'prepare':
        await db.query('UPDATE jobs SET stage = $2, prepared_by = $3, responsible_user_id = NULL, updated_at = now() WHERE id = $1', [job.id, to, actorId]); break;
      case 'check':
        await db.query('UPDATE jobs SET stage = $2, checked_by = $3, responsible_user_id = NULL, updated_at = now() WHERE id = $1', [job.id, to, actorId]); break;
      case 'file':
        await db.query('UPDATE jobs SET stage = $2, filed_by = $3, responsible_user_id = NULL, updated_at = now() WHERE id = $1', [job.id, to, actorId]); break;
      case 'cancel':
        await db.query('UPDATE jobs SET stage = $2, cancelled_from_stage = $3, responsible_user_id = NULL, updated_at = now() WHERE id = $1', [job.id, to, job.stage]); break;
      case 'reopen':
        await db.query(`UPDATE jobs SET stage = $2, prepared_by = NULL, checked_by = NULL, filed_by = NULL, cancelled_from_stage = NULL,
                        responsible_user_id = NULL, updated_at = now() WHERE id = $1`, [job.id, to]); break;
      case 'reassign':
        await activeStaff(db, body.user_id);
        await db.query('UPDATE jobs SET responsible_user_id = $2, updated_at = now() WHERE id = $1', [job.id, body.user_id]);
        meta.from_user = job.responsible_user_id; meta.to_user = body.user_id; break;
      case 'admin_fix': {
        const fix = body.fix ?? {};
        const sets = []; const p = [job.id];
        if (fix.stage !== undefined) {
          if (!FIX_STAGES.includes(fix.stage)) throw new HttpError(400, `fix.stage must be one of ${FIX_STAGES.join(', ')}`);
          sets.push(`stage = $${p.push(fix.stage)}`, CLEAR[fix.stage]); to = fix.stage;
        }
        if (fix.responsible_user_id !== undefined) {
          if (fix.responsible_user_id !== null) await activeStaff(db, fix.responsible_user_id);
          sets.push(`responsible_user_id = $${p.push(fix.responsible_user_id)}`);
        }
        if (!sets.length) throw new HttpError(400, 'admin_fix needs fix.stage and/or fix.responsible_user_id');
        await db.query(`UPDATE jobs SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, p);
        meta.fix = fix; meta.before = { stage: job.stage, responsible_user_id: job.responsible_user_id }; break;
      }
      default: throw new HttpError(400, 'Unsupported action');
    }

    const g = res.matchedGrant;
    if (g?.source === 'delegated') meta.via_delegation = { delegator_id: g.delegator_id };
    await audit(db, { actor: actorId, action, job: job.id, from: job.stage, to, decision: 'ALLOW', reason: body.reason ?? null, grant: res.matchedGrantId, meta });
    const { rows: [updated] } = await db.query('SELECT * FROM jobs WHERE id = $1', [job.id]);
    await db.query('COMMIT');
    return { job: updated, result: res };
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}
