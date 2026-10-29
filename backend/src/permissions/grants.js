// Loads the grants that apply to a user AT A GIVEN MOMENT (own + delegated). Never cached across requests.
export const DIMS = ['client_id', 'branch_id', 'direction', 'mode'];
// A delegate never receives admin-type powers.
export const DELEGATION_EXCLUDED = new Set(['grants.manage', 'job.admin_fix']);

const GRANT_SQL = `
  SELECT g.id, g.user_id, g.role, g.client_id, g.branch_id, g.direction, g.mode, g.valid_from, g.valid_to,
         r.permissions, r.grantable_roles
  FROM grants g
  JOIN roles r ON r.name = g.role
  JOIN users u ON u.id = g.user_id AND u.active
  WHERE g.user_id = ANY($1::int[])
    AND g.valid_from <= $2
    AND (g.valid_to IS NULL OR g.valid_to > $2)
    AND (g.revoked_at IS NULL OR g.revoked_at > $2)`;

const DELEGATION_SQL = `
  SELECT d.id, d.from_user, d.scope_client_id, d.scope_branch_id
  FROM delegations d
  WHERE d.to_user = $1 AND d.valid_from <= $2 AND d.valid_to > $2
    AND (d.revoked_at IS NULL OR d.revoked_at > $2)`;

function narrow(g, d) {
  if (d.scope_client_id != null && g.client_id != null && g.client_id !== d.scope_client_id) return null;
  if (d.scope_branch_id != null && g.branch_id != null && g.branch_id !== d.scope_branch_id) return null;
  return { ...g, client_id: g.client_id ?? d.scope_client_id, branch_id: g.branch_id ?? d.scope_branch_id };
}

/** Effective grants = own grants + the delegator's grants (intersected with delegation scope, minus admin powers). */
export async function loadEffectiveGrants(db, userId, at = new Date()) {
  const { rows: own } = await db.query(GRANT_SQL, [[userId], at]);
  const grants = own.map((g) => ({ ...g, source: 'own', delegator_id: null, delegation_id: null }));
  const { rows: dels } = await db.query(DELEGATION_SQL, [userId, at]);
  if (dels.length) {
    const { rows: theirs } = await db.query(GRANT_SQL, [dels.map((d) => d.from_user), at]);
    for (const d of dels) {
      for (const g of theirs.filter((t) => t.user_id === d.from_user)) {
        const eff = narrow(g, d);
        if (!eff) continue;
        grants.push({
          ...eff, permissions: g.permissions.filter((p) => !DELEGATION_EXCLUDED.has(p)), grantable_roles: [],
          source: 'delegated', delegator_id: d.from_user, delegation_id: d.id,
        });
      }
    }
  }

  // console.log(grants);
  return grants;
}

export const scopeMatches = (g, job) => DIMS.every((d) => g[d] == null || g[d] === job[d]);
export const mismatches = (g, job) => DIMS.filter((d) => g[d] != null && g[d] !== job[d]);
/** True when grant `outer` covers every slice that `inner` (a scope) covers. */
export const covers = (outer, inner) => DIMS.every((d) => outer[d] == null || outer[d] === inner[d]);

export const hasPerm = (grants, perm) => grants.some((g) => g.source === 'own' && g.permissions.includes(perm));
export const isManager = (grants) => grants.some((g) => g.permissions.includes('grants.manage') || g.permissions.includes('job.reassign'));

/** Viewing is scoped separately from acting. `internal` = may see internal notes. */
export function visibility(grants, job) {
  const v = grants.filter((g) => g.permissions.includes('job.view') && scopeMatches(g, job));
  return { visible: v.length > 0, internal: v.some((g) => g.permissions.includes('job.view_internal')) };
}

export async function loadNames(db) {
  const { rows } = await db.query(`SELECT 'c' k, id, name FROM clients UNION ALL SELECT 'b', id, name FROM branches`);
  const names = { c: {}, b: {} };
  for (const r of rows) names[r.k][r.id] = r.name;
  return names;
}

export function describeScope(g, names = {}) {
  const p = [];
  if (g.client_id != null) p.push(`client ${names.c?.[g.client_id] ?? g.client_id}`);
  if (g.branch_id != null) p.push(`branch ${names.b?.[g.branch_id] ?? g.branch_id}`);
  if (g.direction) p.push(`${g.direction}s only`);
  if (g.mode) p.push(`${g.mode.toUpperCase()} only`);
  return p.length ? p.join(', ') : 'all clients, branches, directions and modes';
}
