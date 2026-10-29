import { DELEGATION_EXCLUDED } from './grants.js';

const MUTATING = ['job.prepare', 'job.check', 'job.file', 'job.cancel', 'job.reopen', 'job.admin_fix', 'job.reassign', 'job.create_update'];

/**
 * Who held authority over this job at ANY moment in [start, end)?
 * Reconstructed from grants (never deleted) + delegations, not from today's state.
 */
export async function whoCouldHave(db, job, start, end) {
  const { rows: grants } = await db.query(
    `SELECT g.id, g.user_id, g.role, g.valid_from, g.valid_to, g.revoked_at, u.name, u.email, r.permissions
     FROM grants g JOIN roles r ON r.name = g.role JOIN users u ON u.id = g.user_id
     WHERE g.valid_from < $5 AND (g.valid_to IS NULL OR g.valid_to > $4)
       AND (g.revoked_at IS NULL OR g.revoked_at > $4)
       AND r.permissions && $6::text[]
       AND (g.client_id IS NULL OR g.client_id = $1) AND (g.branch_id IS NULL OR g.branch_id = $2)
       AND (g.direction IS NULL OR g.direction = $3::text)
       AND (g.mode IS NULL OR g.mode = $7::text)`,
    [job.client_id, job.branch_id, job.direction, start, end, MUTATING, job.mode]);

  const holders = new Map();
  const add = (g, perms, via) => {
    const h = holders.get(g.user_id) ?? { user_id: g.user_id, name: g.name, email: g.email, permissions: new Set(), via: [] };
    perms.forEach((p) => h.permissions.add(p));
    h.via.push(via);
    holders.set(g.user_id, h);
  };
  for (const g of grants) {
    add(g, g.permissions.filter((p) => MUTATING.includes(p)),
      { type: 'grant', grant_id: g.id, role: g.role, valid_from: g.valid_from, valid_to: g.valid_to, revoked_at: g.revoked_at });
  }

  const { rows: dels } = await db.query(
    `SELECT d.id, d.from_user, d.to_user, u.name, u.email FROM delegations d JOIN users u ON u.id = d.to_user
     WHERE d.valid_from < $4 AND d.valid_to > $3 AND (d.revoked_at IS NULL OR d.revoked_at > $3)
       AND (d.scope_client_id IS NULL OR d.scope_client_id = $1) AND (d.scope_branch_id IS NULL OR d.scope_branch_id = $2)`,
    [job.client_id, job.branch_id, start, end]);
  for (const d of dels) {
    for (const g of grants.filter((x) => x.user_id === d.from_user)) {
      const perms = g.permissions.filter((p) => MUTATING.includes(p) && !DELEGATION_EXCLUDED.has(p));
      if (perms.length) add({ user_id: d.to_user, name: d.name, email: d.email }, perms,
        { type: 'delegation', delegation_id: d.id, from_user: d.from_user, grant_id: g.id, role: g.role });
    }
  }

  const { rows: [st] } = await db.query(
    `SELECT to_stage FROM audit_log WHERE job_id = $1 AND decision = 'ALLOW' AND to_stage IS NOT NULL AND ts < $2 ORDER BY ts DESC, id DESC LIMIT 1`,
    [job.id, end]);
  const { rows: actual } = await db.query(
    `SELECT a.ts, a.actor_id, u.name AS actor_name, a.action, a.from_stage, a.to_stage, a.decision, a.reason, a.matched_grant_id
     FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
     WHERE a.job_id = $1 AND a.ts >= $2 AND a.ts < $3 ORDER BY a.ts, a.id`, [job.id, start, end]);

  return {
    stage_at_end: st?.to_stage ?? (job.created_at < end ? 'Confirmed' : 'not yet created'),
    could: [...holders.values()].map((h) => ({ ...h, permissions: [...h.permissions].sort() })).sort((a, b) => a.name.localeCompare(b.name)),
    actually_did: actual,
  };
}
