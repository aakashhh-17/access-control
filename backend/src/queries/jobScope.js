import { ACTIONS, WAITING_ACTIONS } from '../permissions/actions.js';

// ONE place that turns effective grants into SQL. The list, the count and the visibility filter all use it,
// and it mirrors decide() rule-for-rule (stage, scope, maker != checker incl. delegation).
const COLS = ['client_id', 'branch_id', 'direction', 'mode'];

function scopeSql(g, params) {
  const c = [];
  for (const col of COLS) if (g[col] != null) { params.push(g[col]); c.push(`j.${col} = $${params.length}`); }
  return c.length ? c.join(' AND ') : 'TRUE';
}

/** Jobs the user may SEE (job.view, scoped). */
export function viewWhere(grants, params) {
  const parts = grants.filter((g) => g.permissions.includes('job.view')).map((g) => `(${scopeSql(g, params)})`);
  return parts.length ? `(${parts.join(' OR ')})` : 'FALSE';
}

/** Jobs the user may ACT on right now with prepare/check/file. */
export function waitingWhere(grants, userId, params) {
  const ors = [];
  for (const a of WAITING_ACTIONS) {
    const def = ACTIONS[a];
    for (const g of grants.filter((x) => x.permissions.includes(def.perm))) {
      params.push(def.from);
      const conds = [`j.stage = ANY($${params.length}::text[])`, scopeSql(g, params)];
      if (def.makerChecker) {
        params.push(userId); conds.push(`j.prepared_by IS DISTINCT FROM $${params.length}`);
        if (g.source === 'delegated') { params.push(g.delegator_id); conds.push(`j.prepared_by IS DISTINCT FROM $${params.length}`); }
      }
      ors.push(`(${conds.join(' AND ')})`);
    }
  }
  return ors.length ? `(${ors.join(' OR ')})` : 'FALSE';
}

export const JOB_LIST_SELECT = `
  SELECT j.id, j.ref, j.client_id, c.name AS client_name, j.branch_id, b.name AS branch_name,
         j.direction, j.mode, j.stage, j.responsible_user_id, j.updated_at`;
export const JOB_LIST_FROM = `FROM jobs j JOIN clients c ON c.id = j.client_id JOIN branches b ON b.id = j.branch_id`;

export async function listJobs(db, grants, userId, { view, page, size, q }) {
  const params = [];
  const where = view === 'waiting' ? waitingWhere(grants, userId, params) : viewWhere(grants, params);
  const whereParams = [...params];
  // optional ref search narrows the LIST only; permission filter above is always applied
  const search = q ? ` AND j.ref ILIKE $${params.push(`%${q.replace(/[%_\\]/g, '\\$&')}%`)}` : '';
  params.push(userId, size + 1, (page - 1) * size);
  const n = params.length;
  const { rows } = await db.query(
    `${JOB_LIST_SELECT}, (j.responsible_user_id = $${n - 2}) AS is_mine ${JOB_LIST_FROM}
     WHERE ${where}${search} ORDER BY j.id DESC LIMIT $${n - 1} OFFSET $${n}`, params);
  const out = { page, page_size: size, has_more: rows.length > size, items: rows.slice(0, size) };
  if (view === 'waiting' && !q) out.total = await countWhere(db, where, whereParams);
  return out;
}

const countWhere = async (db, where, params) =>
  (await db.query(`SELECT count(*)::int AS n FROM jobs j WHERE ${where}`, params)).rows[0].n;

export async function waitingCount(db, grants, userId) {
  const params = [];
  return countWhere(db, waitingWhere(grants, userId, params), params);
}
