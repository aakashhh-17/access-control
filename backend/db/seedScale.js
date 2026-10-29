import bcrypt from 'bcryptjs';   
import { pathToFileURL } from 'node:url';
import { pool } from '../src/db.js';
import { config } from '../src/config.js';
import { seedBase, insertJobs, BRANCHES, CLIENTS, DIRECTIONS, MODES } from './seed.js';

const DAY = 86400000;
const TOTAL_USERS = 500;
const SCALE_JOBS = 200_000;
const BATCH = 10_000;

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Base seed + 480 more users (-> 500 total) + 200,000 more jobs. */
export async function seedScale({ log = console.log } = {}) {
  const t0 = Date.now();
  const { U, C, B } = await seedBase({ log });
  const rng = mulberry32(7);
  const pick = (a) => a[Math.floor(rng() * a.length)];
  const now = Date.now();
  const hash = await bcrypt.hash(config.demoPassword, 10);
  const clientIds = Object.values(C); const branchIds = Object.values(B);

  // --- users + grants ---
  const nUsers = TOTAL_USERS - Object.keys(U).length;
  const ROLE_MIX = [['Maker', 40], ['Checker', 25], ['Filer', 15], ['ClientUser', 12], ['BranchManager', 5], ['Supervisor', 3]];
  const roleDeck = ROLE_MIX.flatMap(([r, n]) => Array(n).fill(r));
  const us = Array.from({ length: nUsers }, (_, i) => {
    const role = pick(roleDeck);
    return { i: i + 1, role, client: role === 'ClientUser' ? pick(clientIds) : null };
  });
  const { rows: inserted } = await pool.query(
    `INSERT INTO users(email, name, password_hash, user_type, client_id)
     SELECT e, n, $3, CASE WHEN c IS NULL THEN 'staff' ELSE 'client' END, c
     FROM unnest($1::text[], $2::text[], $4::int[]) AS t(e, n, c) RETURNING id, email`,
    [us.map((u) => `user${String(u.i).padStart(4, '0')}@scale.nfpl.test`), us.map((u) => `Scale User ${u.i}`), hash, us.map((u) => u.client)]);
  const idByEmail = new Map(inserted.map((r) => [r.email, r.id]));
  const grants = { user: [], role: [], client: [], branch: [], dir: [], mode: [], from: [] };
  const byRole = { Maker: [], Checker: [], Filer: [], Supervisor: [] };
  for (const u of us) {
    const id = idByEmail.get(`user${String(u.i).padStart(4, '0')}@scale.nfpl.test`);
    if (byRole[u.role]) byRole[u.role].push(id);
    const n = u.role === 'ClientUser' ? 1 : 1 + Math.floor(rng() * 3);
    for (let k = 0; k < n; k++) {
      grants.user.push(id); grants.role.push(u.role);
      grants.client.push(u.role === 'ClientUser' ? u.client : (rng() < 0.4 ? null : pick(clientIds)));
      grants.branch.push(u.role === 'ClientUser' ? null : (rng() < 0.4 ? null : pick(branchIds)));
      grants.dir.push(u.role === 'ClientUser' || rng() < 0.7 ? null : pick(DIRECTIONS));
      grants.mode.push(u.role === 'ClientUser' || rng() < 0.7 ? null : pick(MODES));
      grants.from.push(new Date(now - 30 * DAY));
    }
  }
  await pool.query(
    `INSERT INTO grants(user_id, role, client_id, branch_id, direction, mode, valid_from, created_at, created_by)
     SELECT u, r, c, b, d, m, f, f, $8 FROM unnest($1::int[], $2::text[], $3::int[], $4::int[], $5::text[], $6::text[], $7::timestamptz[]) AS t(u, r, c, b, d, m, f)`,
    [grants.user, grants.role, grants.client, grants.branch, grants.dir, grants.mode, grants.from, U.admin]);
  log(`users: ${Object.keys(U).length + nUsers}, new grants: ${grants.user.length}`);

  // --- jobs ---
  const makers = byRole.Maker.length ? byRole.Maker : [U['maker.all']];
  const checkers = byRole.Checker.length ? byRole.Checker : [U['checker.all']];
  const filers = byRole.Filer.length ? byRole.Filer : [U['filer.all']];
  const STAGES = ['Confirmed', 'Confirmed', 'Confirmed', 'Prepared', 'Prepared', 'Checked', 'Filed', 'Filed', 'Cancelled', 'Reopened'];
  let n = 0;
  while (n < SCALE_JOBS) {
    const size = Math.min(BATCH, SCALE_JOBS - n);
    const rows = [];
    for (let i = 0; i < size; i++, n++) {
      const stage = pick(STAGES);
      const created = new Date(now - (2 + rng() * 180) * DAY);
      const prep = pick(makers);
      const chkd = pick(checkers); const fil = pick(filers);
      const progressed = ['Prepared', 'Checked', 'Filed'].includes(stage);
      rows.push({
        ref: `NFPL-S-${String(n + 1).padStart(7, '0')}`,
        client_id: pick(clientIds), branch_id: pick(branchIds), direction: pick(DIRECTIONS), mode: pick(MODES), stage,
        cancelled_from_stage: stage === 'Cancelled' ? 'Confirmed' : null,
        prepared_by: progressed ? prep : null,
        checked_by: stage === 'Checked' || stage === 'Filed' ? chkd : null,
        filed_by: stage === 'Filed' ? fil : null,
        responsible_user_id: stage === 'Confirmed' || stage === 'Reopened' ? prep : stage === 'Prepared' ? chkd : stage === 'Checked' ? fil : null,
        internal_notes: `Scale job ${n + 1}`, created_at: created, updated_at: created,
      });
    }
    await insertJobs(rows);
    log(`jobs: ${n}/${SCALE_JOBS}`);
  }
  await pool.query('ANALYZE');
  log(`scale seed done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedScale()
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => pool.end());
}
