import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { boot, pool } from './helpers.js';

let t;
beforeAll(async () => { t = await boot(); });
afterAll(() => pool.end());

const day = (d) => d.toISOString().slice(0, 10);
const names = (body) => body.could.map((c) => c.name);

describe('"Who could have changed this job on the 3rd?"', () => {
  const ref = 'NFPL-DEMO-REVOKED-DONE'; // Everest / Chennai / export / air - checked by Gita 15 days ago

  it('reconstructs from the grants held THEN, not now', async () => {
    const { rows: [chk] } = await pool.query(`SELECT ts, actor_id FROM audit_log WHERE job_id = $1 AND action = 'check'`, [t.jid(ref)]);
    const admin = await t.as('admin');
    const then = (await admin.get(`/jobs/${t.jid(ref)}/who-could-have?date=${day(chk.ts)}`)).body;
    expect(names(then)).toContain('Gita Grant-Changed');      // held global Checker that day
    expect(names(then)).toContain('Charu Checker-All');
    expect(names(then)).toContain('Murali Maker-Chennai');
    expect(names(then)).not.toContain('Kabir Checker-Kolkata'); // Kolkata only
    expect(names(then)).not.toContain('Carla Cover');           // Coastal only
    expect(then.stage_at_end).toBe('Checked');
    const gita = then.could.find((c) => c.name === 'Gita Grant-Changed');
    expect(gita.via[0]).toMatchObject({ type: 'grant', grant_id: t.G['changed.grant.old'] });
    // "who actually did"
    const did = then.actually_did.find((a) => a.action === 'check');
    expect(did).toMatchObject({ actor_id: t.uid('changed.grant'), matched_grant_id: t.G['changed.grant.old'] });

    const now = (await admin.get(`/jobs/${t.jid(ref)}/who-could-have?date=${day(new Date())}`)).body;
    expect(names(now)).not.toContain('Gita Grant-Changed');    // revoked 10 days ago
    expect(names(now)).toContain('Charu Checker-All');
  });

  it('before anyone had access, nobody could have', async () => {
    const r = (await (await t.as('admin')).get(`/jobs/${t.jid(ref)}/who-could-have?date=${day(new Date(Date.now() - 200 * 86400000))}`)).body;
    expect(r.could).toEqual([]);
    expect(r.stage_at_end).toBe('not yet created');
  });

  it('shows delegates, and why (delegation vs grant)', async () => {
    const r = (await (await t.as('admin')).get(`/jobs/${t.jid('NFPL-DEMO-ABSENT-1')}/who-could-have?date=${day(new Date())}`)).body;
    const carla = r.could.find((c) => c.name === 'Carla Cover');
    expect(carla.via[0]).toMatchObject({ type: 'delegation', from_user: t.uid('owner.absent') });
  });

  it('is for managers only; bad dates are rejected', async () => {
    expect((await (await t.as('maker.mum')).get(`/jobs/${t.jid('NFPL-DEMO-ACME-PREP')}/who-could-have?date=2026-01-03`)).status).toBe(403);
    expect((await (await t.as('admin')).get(`/jobs/${t.jid(ref)}/who-could-have?date=not-a-date`)).status).toBe(400);
  });
});

describe('job history', () => {
  it('is chronological, includes DENY attempts, actors and reasons for staff', async () => {
    const h = (await (await t.as('maker.mum')).get(`/jobs/${t.jid('NFPL-DEMO-CONFLICT')}/history`)).body;
    expect(h.map((e) => e.action)).toEqual(expect.arrayContaining(['create', 'prepare', 'check']));
    expect(h.find((e) => e.decision === 'DENY')).toMatchObject({ actor_name: 'Dev Dual', reason: expect.stringMatching(/maker\/checker/) });
    const ts = h.map((e) => +new Date(e.ts));
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });
  it('shows cancel + reopen with their reasons', async () => {
    const h = (await (await t.as('super')).get(`/jobs/${t.jid('NFPL-DEMO-REOPENED')}/history`)).body;
    expect(h.filter((e) => ['cancel', 'reopen'].includes(e.action)).every((e) => e.reason)).toBe(true);
  });
});
