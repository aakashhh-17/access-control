import bcrypt from 'bcryptjs';   
import { pathToFileURL } from 'node:url';
import { pool } from '../src/db.js';
import { config } from '../src/config.js';
import { migrate } from './migrate.js';

const DAY = 86400000;
const HOUR = 3600000;

export const BRANCHES = [['mumbai', 'MUM', 'Mumbai'], ['delhi', 'DEL', 'Delhi'], ['chennai', 'CHE', 'Chennai'], ['kolkata', 'KOL', 'Kolkata'], ['cochin', 'COK', 'Cochin']];
export const CLIENTS = [['acme', 'Acme Textiles'], ['bharat', 'Bharat Pharma'], ['coastal', 'Coastal Spices'], ['delta', 'Delta Auto Parts'], ['everest', 'Everest Electronics'], ['falcon', 'Falcon Foods'], ['gangetic', 'Gangetic Leather'], ['helios', 'Helios Solar'], ['indus', 'Indus Chemicals'], ['jade', 'Jade Furnishings']];
export const DIRECTIONS = ['import', 'export'];
export const MODES = ['air', 'fcl', 'lcl'];

const STAFF_VIEW = ['job.view', 'job.view_internal'];
export const ROLES = [
  { name: 'Maker', description: 'Prepares jobs', permissions: [...STAFF_VIEW, 'job.prepare'], grantable: [] },
  { name: 'Checker', description: 'Checks prepared jobs', permissions: [...STAFF_VIEW, 'job.check'], grantable: [] },
  { name: 'Filer', description: 'Files checked jobs', permissions: [...STAFF_VIEW, 'job.file'], grantable: [] },
  { name: 'Supervisor', description: 'Cancel/reopen, including filed jobs', permissions: [...STAFF_VIEW, 'job.cancel', 'job.reopen', 'job.cancel_filed', 'job.reopen_filed', 'job.reassign'], grantable: [] },
  { name: 'BranchManager', description: 'Runs a branch: cancel/reopen unfiled, reassign, manage Maker/Checker/Filer grants', permissions: [...STAFF_VIEW, 'job.cancel', 'job.reopen', 'job.reassign', 'grants.manage'], grantable: ['Maker', 'Checker', 'Filer'] },
  { name: 'Admin', description: 'Manages grants, fixes stuck jobs. Cannot work jobs itself', permissions: [...STAFF_VIEW, 'grants.manage', 'job.admin_fix'], grantable: ['Maker', 'Checker', 'Filer', 'Supervisor', 'BranchManager', 'ClientUser', 'Parser'] },
  { name: 'ClientUser', description: 'Client-side, read-only, no internal notes', permissions: ['job.view'], grantable: [] },
  { name: 'Parser', description: 'Service account: create/update jobs only', permissions: ['job.create_update'], grantable: [] },
];

// [key, email, name, type, clientKey]
const USERS = [
  ['admin', 'admin@nfpl.test', 'Anita Admin', 'staff'],
  ['maker.all', 'maker.all@nfpl.test', 'Meera Maker-All', 'staff'],
  ['checker.narrow', 'checker.narrow@nfpl.test', 'Chirag Checker-Narrow', 'staff'],
  ['both.dual', 'both.dual@nfpl.test', 'Dev Dual', 'staff'],
  ['owner.absent', 'owner.absent@nfpl.test', 'Om Absent', 'staff'],
  ['cover.deleg', 'cover.deleg@nfpl.test', 'Carla Cover', 'staff'],
  ['changed.grant', 'changed.grant@nfpl.test', 'Gita Grant-Changed', 'staff'],
  ['filer.all', 'filer.all@nfpl.test', 'Farah Filer-All', 'staff'],
  ['filer.mum', 'filer.mum@nfpl.test', 'Faisal Filer-Mumbai', 'staff'],
  ['super', 'super@nfpl.test', 'Sunil Supervisor', 'staff'],
  ['bm.mumbai', 'bm.mumbai@nfpl.test', 'Bina Branch-Mumbai', 'staff'],
  ['bm.delhi', 'bm.delhi@nfpl.test', 'Bhavya Branch-Delhi', 'staff'],
  ['client.acme', 'client.acme@nfpl.test', 'Alok (Acme client)', 'client', 'acme'],
  ['client.bharat', 'client.bharat@nfpl.test', 'Bhumi (Bharat client)', 'client', 'bharat'],
  ['parser', 'parser@nfpl.test', 'Overnight Parser', 'service'],
  ['maker.mum', 'maker.mum@nfpl.test', 'Mohan Maker-Mumbai', 'staff'],
  ['maker.del', 'maker.del@nfpl.test', 'Maya Maker-Delhi', 'staff'],
  ['maker.chennai', 'maker.chennai@nfpl.test', 'Murali Maker-Chennai', 'staff'],
  ['checker.all', 'checker.all@nfpl.test', 'Charu Checker-All', 'staff'],
  ['checker.kol', 'checker.kol@nfpl.test', 'Kabir Checker-Kolkata', 'staff'],
];

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bulk insert via unnest (fast, no extra deps). rows use resolved numeric ids. Returns Map(ref -> id). */
export async function insertJobs(rows, db = pool) {
  const col = (k) => rows.map((r) => r[k] ?? null);
  const { rows: out } = await db.query(
    `INSERT INTO jobs (ref, client_id, branch_id, direction, mode, stage, cancelled_from_stage,
                       prepared_by, checked_by, filed_by, responsible_user_id, internal_notes, created_at, updated_at)
     SELECT * FROM unnest($1::text[], $2::int[], $3::int[], $4::text[], $5::text[], $6::text[], $7::text[],
                          $8::int[], $9::int[], $10::int[], $11::int[], $12::text[], $13::timestamptz[], $14::timestamptz[])
     RETURNING id, ref`,
    ['ref', 'client_id', 'branch_id', 'direction', 'mode', 'stage', 'cancelled_from_stage', 'prepared_by', 'checked_by', 'filed_by', 'responsible_user_id', 'internal_notes', 'created_at', 'updated_at'].map(col),
  );
  return new Map(out.map((r) => [r.ref, r.id]));
}

export async function seedBase({ now = new Date(), log = console.log } = {}) {
  await migrate({ reset: true });
  const q = (t, p) => pool.query(t, p);
  const ago = (d) => new Date(now.getTime() - d * DAY);
  const ahead = (d) => new Date(now.getTime() + d * DAY);
  const hash = await bcrypt.hash(config.demoPassword, 10);

  // --- reference data ---
  for (const r of ROLES) await q('INSERT INTO roles(name, description, permissions, grantable_roles) VALUES ($1,$2,$3,$4)', [r.name, r.description, r.permissions, r.grantable]);
  const B = {}; const C = {}; const U = {};
  for (const [k, code, name] of BRANCHES) B[k] = (await q('INSERT INTO branches(code, name) VALUES ($1,$2) RETURNING id', [code, name])).rows[0].id;
  for (const [k, name] of CLIENTS) C[k] = (await q('INSERT INTO clients(name) VALUES ($1) RETURNING id', [name])).rows[0].id;
  for (const [k, email, name, type, ck] of USERS) {
    U[k] = (await q('INSERT INTO users(email, name, password_hash, user_type, client_id) VALUES ($1,$2,$3,$4,$5) RETURNING id', [email, name, hash, type, ck ? C[ck] : null])).rows[0].id;
  }

  // --- audit helper ---
  const audit = (o) => q(
    `INSERT INTO audit_log(ts, actor_id, action, job_id, from_stage, to_stage, decision, reason, matched_grant_id, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [o.ts, o.actor ?? null, o.action, o.job ?? null, o.from ?? null, o.to ?? null, o.decision ?? 'ALLOW', o.reason ?? null, o.grant ?? null, JSON.stringify(o.meta ?? {})]);

  // --- grants (+ grant history in audit_log) ---
  const G = {};
  async function grant(label, user, role, scope = {}, o = {}) {
    const from = o.from ?? ago(60);
    const by = 'by' in o ? o.by : 'admin';
    const { rows: [g] } = await q(
      `INSERT INTO grants(user_id, role, client_id, branch_id, direction, mode, valid_from, valid_to, created_by, created_at, revoked_at, revoked_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$7,$10,$11) RETURNING id`,
      [U[user], role, scope.client ? C[scope.client] : null, scope.branch ? B[scope.branch] : null, scope.direction ?? null, scope.mode ?? null,
        from, o.to ?? null, by ? U[by] : null, o.revokedAt ?? null, o.revokedAt ? U.admin : null]);
    G[label] = g.id;
    const meta = { grant_id: g.id, target_user: U[user], role, scope };
    await audit({ ts: from, actor: by ? U[by] : null, action: 'grant.create', meta });
    if (o.revokedAt) await audit({ ts: o.revokedAt, actor: U.admin, action: 'grant.revoke', meta });
  }

  await grant('admin', 'admin', 'Admin', {}, { by: null, from: ago(90) }); // bootstrap grant
  await grant('maker.all', 'maker.all', 'Maker');                                    // Maker for EVERY client...
  await grant('maker.all.chk.acme', 'maker.all', 'Checker', { client: 'acme' });     // ...Checker for only two
  await grant('maker.all.chk.bharat', 'maker.all', 'Checker', { client: 'bharat' });
  await grant('checker.narrow', 'checker.narrow', 'Checker', { client: 'acme', branch: 'mumbai', direction: 'import' });
  await grant('both.dual.maker', 'both.dual', 'Maker');
  await grant('both.dual.checker', 'both.dual', 'Checker');
  await grant('owner.absent.acme', 'owner.absent', 'Maker', { client: 'acme' });
  await grant('owner.absent.bharat', 'owner.absent', 'Maker', { client: 'bharat' });
  await grant('cover.deleg', 'cover.deleg', 'Maker', { client: 'coastal' });
  await grant('changed.grant.old', 'changed.grant', 'Checker', {}, { from: ago(60), revokedAt: ago(10), to: undefined });   // was global Checker, revoked 10 days ago
  await grant('changed.grant.new', 'changed.grant', 'Checker', { client: 'delta' }, { from: ago(10) });                       // now Delta only
  await grant('filer.all', 'filer.all', 'Filer');
  await grant('filer.mum', 'filer.mum', 'Filer', { branch: 'mumbai' });
  await grant('super', 'super', 'Supervisor');
  await grant('bm.mumbai', 'bm.mumbai', 'BranchManager', { branch: 'mumbai' });
  await grant('bm.delhi', 'bm.delhi', 'BranchManager', { branch: 'delhi' });
  await grant('client.acme', 'client.acme', 'ClientUser', { client: 'acme' });
  await grant('client.bharat', 'client.bharat', 'ClientUser', { client: 'bharat' });
  await grant('parser', 'parser', 'Parser');
  await grant('maker.mum', 'maker.mum', 'Maker', { branch: 'mumbai' });
  await grant('maker.del', 'maker.del', 'Maker', { branch: 'delhi' });
  await grant('maker.chennai', 'maker.chennai', 'Maker', { branch: 'chennai' });
  await grant('checker.all', 'checker.all', 'Checker');
  await grant('checker.kol', 'checker.kol', 'Checker', { branch: 'kolkata' });

  // --- delegation: Om is away, Carla covers (all of Om's scope, no more) ---
  await q(`INSERT INTO delegations(from_user, to_user, valid_from, valid_to, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
    [U['owner.absent'], U['cover.deleg'], ago(1), ahead(13), 'Om on leave', U['bm.mumbai']]);
  await audit({ ts: ago(1), actor: U['bm.mumbai'], action: 'delegation.create', meta: { from: U['owner.absent'], to: U['cover.deleg'] } });

  // --- jobs ---
  // o: client, branch, direction, mode, stage, prep/chk/fil (user keys, drive the audit trail), resp, notes, age (days),
  //    tail: extra [action, from, to, actorKey, reason], reset: clear prepared/checked/filed columns (after reopen), mg: {action: grantLabel}
  const NAMED = [
    ['NFPL-DEMO-CONFLICT', { client: 'acme', branch: 'mumbai', direction: 'import', mode: 'fcl', stage: 'Prepared', prep: 'both.dual', resp: 'checker.all', notes: 'Prepared by Dev Dual, who is also a qualified Checker -> must be denied on check.' }],
    ['NFPL-DEMO-ACME-PREP', { client: 'acme', branch: 'mumbai', direction: 'import', mode: 'lcl', stage: 'Prepared', prep: 'maker.mum', resp: 'checker.narrow', notes: 'Meera, Chirag, Dev and Charu may check this one.' }],
    ['NFPL-DEMO-DELTA-PREP', { client: 'delta', branch: 'delhi', direction: 'export', mode: 'air', stage: 'Prepared', prep: 'maker.del', resp: 'changed.grant', notes: 'Meera (Maker-All) has no Checker grant for Delta; Gita does.' }],
    ['NFPL-DEMO-EXPORT-NARROW', { client: 'acme', branch: 'mumbai', direction: 'export', mode: 'air', stage: 'Prepared', prep: 'maker.mum', notes: 'Export: Chirag (imports only) must be denied.' }],
    ['NFPL-DEMO-ABSENT-1', { client: 'acme', branch: 'mumbai', direction: 'import', mode: 'air', stage: 'Confirmed', resp: 'owner.absent', notes: 'Owner on leave; Carla covers via delegation.' }],
    ['NFPL-DEMO-ABSENT-2', { client: 'bharat', branch: 'delhi', direction: 'export', mode: 'fcl', stage: 'Confirmed', resp: 'owner.absent' }],
    ['NFPL-DEMO-ABSENT-3', { client: 'bharat', branch: 'chennai', direction: 'import', mode: 'lcl', stage: 'Confirmed', resp: 'owner.absent' }],
    ['NFPL-DEMO-REVOKED-OPEN', { client: 'everest', branch: 'mumbai', direction: 'import', mode: 'lcl', stage: 'Prepared', prep: 'maker.mum', resp: 'changed.grant', notes: 'Was in Gita\'s queue until her global Checker grant was revoked (10 days ago).' }],
    ['NFPL-DEMO-REVOKED-DONE', { client: 'everest', branch: 'chennai', direction: 'export', mode: 'air', stage: 'Checked', prep: 'maker.chennai', chk: 'changed.grant', resp: 'filer.all', age: 15, mg: { prepare: 'maker.chennai', check: 'changed.grant.old' }, notes: 'Checked by Gita while her old grant was valid; history is preserved.' }],
    ['NFPL-DEMO-FILED', { client: 'acme', branch: 'mumbai', direction: 'export', mode: 'fcl', stage: 'Filed', prep: 'maker.mum', chk: 'checker.all', fil: 'filer.all', age: 12, mg: { prepare: 'maker.mum', check: 'checker.all', file: 'filer.all' }, notes: 'Filed. Cancel/reopen needs a Supervisor-level grant + reason.' }],
    ['NFPL-DEMO-CANCELLED', { client: 'falcon', branch: 'delhi', direction: 'import', mode: 'air', stage: 'Cancelled', cancelledFrom: 'Confirmed', age: 8, tail: [['cancel', 'Confirmed', 'Cancelled', 'super', 'Duplicate booking - client withdrew']] }],
    ['NFPL-DEMO-REOPENED', { client: 'gangetic', branch: 'kolkata', direction: 'export', mode: 'lcl', stage: 'Reopened', prep: 'maker.all', chk: 'checker.all', fil: 'filer.all', reset: true, age: 20, tail: [['cancel', 'Filed', 'Cancelled', 'super', 'Wrong HS code discovered after filing'], ['reopen', 'Cancelled', 'Reopened', 'super', 'Re-prepare with corrected HS code']], resp: 'maker.all' }],
  ];

  const rng = mulberry32(42);
  const pick = (a) => a[Math.floor(rng() * a.length)];
  const STAGES = ['Confirmed', 'Confirmed', 'Confirmed', 'Prepared', 'Prepared', 'Checked', 'Filed', 'Filed', 'Cancelled', 'Reopened'];
  const makerFor = (br) => ({ mumbai: 'maker.mum', delhi: 'maker.del', chennai: 'maker.chennai' }[br] ?? 'maker.all');
  const checkerFor = (br) => (br === 'kolkata' ? 'checker.kol' : 'checker.all');
  const filerFor = (br) => (br === 'mumbai' && rng() < 0.5 ? 'filer.mum' : 'filer.all');

  const ckeys = CLIENTS.map((c) => c[0]); const bkeys = BRANCHES.map((b) => b[0]);
  for (let i = 1; i <= 300; i++) {
    const client = pick(ckeys); const branch = pick(bkeys); const stage = pick(STAGES);
    const mk = makerFor(branch);
    const o = { client, branch, direction: pick(DIRECTIONS), mode: pick(MODES), stage, age: 3 + Math.floor(rng() * 60) };
    if (['Prepared', 'Checked', 'Filed'].includes(stage)) o.prep = mk;
    if (['Checked', 'Filed'].includes(stage)) o.chk = checkerFor(branch);
    if (stage === 'Filed') o.fil = filerFor(branch);
    if (stage === 'Cancelled') { o.cancelledFrom = 'Confirmed'; o.tail = [['cancel', 'Confirmed', 'Cancelled', 'super', 'Client withdrew booking']]; }
    if (stage === 'Reopened') { o.prep = mk; o.chk = checkerFor(branch); o.fil = filerFor(branch); o.reset = true; o.tail = [['cancel', 'Filed', 'Cancelled', 'super', 'Amendment needed'], ['reopen', 'Cancelled', 'Reopened', 'super', 'Amendment approved']]; }
    o.resp = { Confirmed: (client === 'acme' || client === 'bharat') && rng() < 0.2 ? 'owner.absent' : mk, Reopened: mk, Prepared: checkerFor(branch), Checked: filerFor(branch) }[stage] ?? null;
    NAMED.push([`NFPL-${String(2026000 + i)}`, o]);
  }

  const steps = (o) => {
    const s = [['create', null, 'Confirmed', 'parser']];
    if (o.prep) s.push(['prepare', 'Confirmed', 'Prepared', o.prep]);
    if (o.chk) s.push(['check', 'Prepared', 'Checked', o.chk]);
    if (o.fil) s.push(['file', 'Checked', 'Filed', o.fil]);
    return s.concat(o.tail ?? []);
  };
  const jobRows = []; const trail = [];
  for (const [ref, o] of NAMED) {
    const created = ago(o.age ?? 20);
    const st = steps(o).map((s, i) => ({ s, ts: new Date(created.getTime() + i * 6 * HOUR) }));
    jobRows.push({
      ref, client_id: C[o.client], branch_id: B[o.branch], direction: o.direction, mode: o.mode, stage: o.stage, cancelled_from_stage: o.cancelledFrom ?? null,
      prepared_by: !o.reset && o.prep ? U[o.prep] : null, checked_by: !o.reset && o.chk ? U[o.chk] : null, filed_by: !o.reset && o.fil ? U[o.fil] : null,
      responsible_user_id: o.resp ? U[o.resp] : null, internal_notes: o.notes ?? `Internal: handling instructions for ${ref}`,
      created_at: created, updated_at: st[st.length - 1].ts,
    });
    trail.push({ ref, o, st });
  }
  const ids = await insertJobs(jobRows);

  const au = { ts: [], actor: [], action: [], job: [], from: [], to: [], reason: [], grant: [] };
  for (const { ref, o, st } of trail) {
    for (const { s: [action, from, to, actor, reason], ts } of st) {
      au.ts.push(ts); au.actor.push(U[actor]); au.action.push(action); au.job.push(ids.get(ref));
      au.from.push(from); au.to.push(to); au.reason.push(reason ?? null); au.grant.push(o.mg?.[action] ? G[o.mg[action]] : null);
    }
  }
  await q(
    `INSERT INTO audit_log(ts, actor_id, action, job_id, from_stage, to_stage, decision, reason, matched_grant_id)
     SELECT ts, actor, action, job, fr, tt, 'ALLOW', reason, grant_id
     FROM unnest($1::timestamptz[], $2::int[], $3::text[], $4::int[], $5::text[], $6::text[], $7::text[], $8::int[]) AS t(ts, actor, action, job, fr, tt, reason, grant_id)`,
    [au.ts, au.actor, au.action, au.job, au.from, au.to, au.reason, au.grant]);

  // --- awkward audit scenarios ---
  // Admin tried to give themselves Maker: blocked and logged.
  await audit({ ts: ago(2), actor: U.admin, action: 'grant.create', decision: 'DENY', reason: 'self-escalation blocked: cannot grant a role to yourself',
    meta: { target_user: U.admin, role: 'Maker', attempted: true } });
  // A denied maker/checker attempt on the conflict job.
  await audit({ ts: ago(1), actor: U['both.dual'], action: 'check', job: ids.get('NFPL-DEMO-CONFLICT'), from: 'Prepared', to: 'Checked', decision: 'DENY',
    reason: 'maker/checker conflict: you prepared this job' });
  // An admin_fix example on a Checked job (stuck: filer left).
  await audit({ ts: ago(3), actor: U.admin, action: 'admin_fix', job: ids.get('NFPL-DEMO-REVOKED-DONE'), decision: 'ALLOW',
    reason: 'Reassigned responsible user: previous filer left the company', meta: { field: 'responsible_user_id' } });

  log(`seeded: ${BRANCHES.length} branches, ${CLIENTS.length} clients, ${USERS.length} users, ${jobRows.length} jobs`);
  return { U, C, B, G, ids };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedBase()
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => pool.end());
}
