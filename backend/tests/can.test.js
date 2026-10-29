import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { boot, pool, auditCount } from './helpers.js';
import { decide, can } from '../src/permissions/can.js';

let t;
beforeAll(async () => { t = await boot(); });
afterAll(() => pool.end());

const explain = async (jobRef, action, userKey) => {
  const admin = await t.as('admin');
  const r = await admin.get(`/jobs/${t.jid(jobRef)}/can?action=${action}&user_id=${t.uid(userKey)}`);
  expect(r.status).toBe(200);
  return r.body;
};

describe('maker / checker conflict', () => {
  it('preparer cannot check even though qualified; another checker can ("why she can and he can\'t")', async () => {
    const he = await explain('NFPL-DEMO-CONFLICT', 'check', 'both.dual');
    const she = await explain('NFPL-DEMO-CONFLICT', 'check', 'checker.all');
    expect(he.allowed).toBe(false);
    expect(he.reason).toMatch(/maker ≠ checker/);
    expect(he.checks.find((c) => c.name === 'permission').pass).toBe(true); // qualified...
    expect(he.checks.find((c) => c.name === 'maker-checker').pass).toBe(false); // ...but conflicted
    expect(she.allowed).toBe(true);
  });

  it('is enforced on the real action and the denial is audited', async () => {
    const before = await auditCount(`actor_id = $1 AND decision = 'DENY' AND action = 'check' AND job_id = $2`, [t.uid('both.dual'), t.jid('NFPL-DEMO-CONFLICT')]);
    const api = await t.as('both.dual');
    const r = await api.post(`/jobs/${t.jid('NFPL-DEMO-CONFLICT')}/actions`, { action: 'check' });
    expect(r.status).toBe(403);
    const after = await auditCount(`actor_id = $1 AND decision = 'DENY' AND action = 'check' AND job_id = $2`, [t.uid('both.dual'), t.jid('NFPL-DEMO-CONFLICT')]);
    expect(after).toBe(before + 1);
  });
});

describe('grant scoping (NULL = all)', () => {
  it('Maker for all clients but Checker for only some', async () => {
    expect((await explain('NFPL-DEMO-ACME-PREP', 'check', 'maker.all')).allowed).toBe(true);
    const delta = await explain('NFPL-DEMO-DELTA-PREP', 'check', 'maker.all');
    expect(delta.allowed).toBe(false);
    expect(delta.reason).toMatch(/limited to client Acme Textiles/);
    expect((await explain('NFPL-DEMO-DELTA-PREP', 'check', 'changed.grant')).allowed).toBe(true); // Delta checker
  });

  it('Checker for one client + one branch, imports only', async () => {
    expect((await explain('NFPL-DEMO-ACME-PREP', 'check', 'checker.narrow')).allowed).toBe(true);
    const exp = await explain('NFPL-DEMO-EXPORT-NARROW', 'check', 'checker.narrow');
    expect(exp.allowed).toBe(false);
    expect(exp.reason).toMatch(/imports only/);
  });
});

describe('absent owner + delegation', () => {
  it('delegate acts within the delegator\'s scope', async () => {
    const r = await explain('NFPL-DEMO-ABSENT-1', 'prepare', 'cover.deleg');
    expect(r.allowed).toBe(true);
    expect(r.matchedGrant.source).toBe('delegated');
    expect(r.matchedGrant.delegator_id).toBe(t.uid('owner.absent'));
  });

  it('delegation never grants more than the delegator had', async () => {
    const { rows: [delta] } = await pool.query(`SELECT * FROM jobs WHERE stage = 'Confirmed' AND client_id = $1 LIMIT 1`, [t.C.delta]);
    const r = await can(pool, t.uid('cover.deleg'), 'prepare', delta, { logUnsure: false });
    expect(r.allowed).toBe(false); // Om has no Delta grant, Carla only Coastal
  });

  it('admin powers are never delegated', async () => {
    const admin = await t.as('admin');
    const d = await admin.post('/delegations', { to_user: t.uid('cover.deleg'), valid_to: new Date(Date.now() + 86400000).toISOString(), reason: 'test' });
    expect(d.status).toBe(201);
    const carla = await t.as('cover.deleg');
    expect((await carla.post('/grants', { user_id: t.uid('maker.mum'), role: 'Maker' })).status).toBe(403);
    const r = await can(pool, t.uid('cover.deleg'), 'admin_fix', { ...(await pool.query('SELECT * FROM jobs WHERE id = $1', [t.jid('NFPL-DEMO-ABSENT-2')])).rows[0] }, {});
    expect(r.allowed).toBe(false);
  });

  it('delegation cannot bypass maker != checker', async () => {
    // both.dual prepared NFPL-DEMO-CONFLICT. Delegate dual's Checker authority to Carla: she must still be denied there...
    const admin = await t.as('admin');
    const d = await admin.post('/delegations', { from_user: t.uid('both.dual'), to_user: t.uid('cover.deleg'), valid_to: new Date(Date.now() + 86400000).toISOString() });
    expect(d.status).toBe(201);
    const blocked = await explain('NFPL-DEMO-CONFLICT', 'check', 'cover.deleg');
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/delegation cannot bypass/);
    // ...but the same delegated authority works on a job dual did not prepare.
    const ok = await explain('NFPL-DEMO-ACME-PREP', 'check', 'cover.deleg');
    expect(ok.allowed).toBe(true);
    expect(ok.matchedGrant.source).toBe('delegated');
  });
});

describe('unsure = deny (and logged)', () => {
  const user = { id: 1, name: 'U', active: true };
  it('missing job data', () => {
    const r = decide({ user, grants: [], action: 'prepare', job: { stage: 'Confirmed' } });
    expect(r.allowed).toBe(false); expect(r.unsure).toBe(true); expect(r.reason).toMatch(/Denied by default/);
  });
  it('unknown action and unknown user', () => {
    const job = { client_id: 1, branch_id: 1, direction: 'import', mode: 'air', stage: 'Confirmed' };
    expect(decide({ user, grants: [], action: 'launch_rocket', job })).toMatchObject({ allowed: false, unsure: true });
    expect(decide({ user: null, grants: [], action: 'prepare', job })).toMatchObject({ allowed: false, unsure: true });
  });
  it('can() writes an audit row for an unsure denial', async () => {
    const before = await auditCount(`action = 'unsure:check'`);
    const r = await can(pool, t.uid('checker.all'), 'check', { id: t.jid('NFPL-DEMO-ACME-PREP'), stage: 'Prepared', client_id: 1, branch_id: null, direction: 'import', mode: 'air' });
    expect(r.allowed).toBe(false);
    expect(await auditCount(`action = 'unsure:check'`)).toBe(before + 1);
  });
});

describe('client-side user cannot act', () => {
  it('every action denied', async () => {
    const api = await t.as('client.acme');
    const { rows: [acme] } = await pool.query(`SELECT id FROM jobs WHERE client_id = $1 AND stage = 'Confirmed' LIMIT 1`, [t.C.acme]);
    for (const action of ['prepare', 'check', 'file', 'cancel', 'reopen', 'admin_fix']) {
      expect((await api.post(`/jobs/${acme.id}/actions`, { action, reason: 'because' })).status).toBe(403);
    }
  });
});
