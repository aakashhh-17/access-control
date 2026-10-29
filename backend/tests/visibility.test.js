import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { boot, pool } from './helpers.js';
import { decide } from '../src/permissions/can.js';
import { loadEffectiveGrants, loadNames } from '../src/permissions/grants.js';
import { WAITING_ACTIONS } from '../src/permissions/actions.js';

let t;
beforeAll(async () => { t = await boot(); });
afterAll(() => pool.end());

describe('client-side user', () => {
  it('sees only their own client, read-only, without internal notes', async () => {
    const api = await t.as('client.acme');
    const list = await api.get('/jobs?view=all&page_size=100');
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThan(0);
    expect(list.body.items.every((j) => j.client_name === 'Acme Textiles')).toBe(true);

    const own = await api.get(`/jobs/${t.jid('NFPL-DEMO-CONFLICT')}`);
    expect(own.status).toBe(200);
    expect(own.body.job).not.toHaveProperty('internal_notes');
    expect(Object.values(own.body.actions).every((a) => !a.allowed)).toBe(true);

    expect((await api.get(`/jobs/${t.jid('NFPL-DEMO-DELTA-PREP')}`)).status).toBe(404); // other client: not even existence
    expect((await api.get('/jobs/waiting/count')).body.count).toBe(0);
  });
  it('history shows stage movements only - no people, no reasons', async () => {
    const h = await (await t.as('client.acme')).get(`/jobs/${t.jid('NFPL-DEMO-CONFLICT')}/history`);
    expect(h.status).toBe(200);
    expect(h.body.length).toBeGreaterThan(0);
    for (const e of h.body) { expect(e).not.toHaveProperty('actor_name'); expect(e).not.toHaveProperty('reason'); }
  });
  it('staff do see internal notes', async () => {
    const r = await (await t.as('maker.mum')).get(`/jobs/${t.jid('NFPL-DEMO-CONFLICT')}`);
    expect(r.body.job.internal_notes).toBeTruthy();
  });
});

describe('visibility is scoped, separate from acting', () => {
  it('a Delhi-only maker cannot see a Mumbai job', async () => {
    expect((await (await t.as('maker.del')).get(`/jobs/${t.jid('NFPL-DEMO-ACME-PREP')}`)).status).toBe(404);
  });
  it('a user whose grant was revoked mid-job no longer has the job in their queue', async () => {
    const waiting = await (await t.as('changed.grant')).get('/jobs?view=waiting&page_size=100');
    expect(waiting.body.items.map((j) => j.ref)).not.toContain('NFPL-DEMO-REVOKED-OPEN');
    expect(waiting.body.items.map((j) => j.ref)).toContain('NFPL-DEMO-DELTA-PREP');
  });
});

describe('waiting count == waiting list == what the user can actually do', () => {
  const users = ['checker.narrow', 'filer.mum', 'checker.kol', 'changed.grant', 'cover.deleg', 'owner.absent', 'maker.chennai', 'both.dual', 'maker.all', 'filer.all', 'checker.all'];
  it.each(users)('%s', async (key) => {
    const api = await t.as(key);
    const count = (await api.get('/jobs/waiting/count')).body.count;
    // walk every page
    const refs = [];
    for (let p = 1; ; p++) {
      const r = await api.get(`/jobs?view=waiting&page=${p}&page_size=50`);
      refs.push(...r.body.items.map((i) => i.id));
      expect(r.body.total).toBe(count);
      if (!r.body.has_more) break;
    }
    expect(refs.length).toBe(count);
    expect(new Set(refs).size).toBe(count); // no duplicates across pages

    // ground truth: run the single decision function over every job
    const { rows: [user] } = await pool.query('SELECT id, name, email, user_type, client_id, active FROM users WHERE id = $1', [t.uid(key)]);
    const grants = await loadEffectiveGrants(pool, user.id);
    const names = await loadNames(pool);
    const { rows: jobs } = await pool.query('SELECT * FROM jobs ORDER BY id DESC');
    const allowed = jobs.filter((j) => WAITING_ACTIONS.some((a) => decide({ user, grants, action: a, job: j, names }).allowed)).map((j) => j.id);
    expect(new Set(refs)).toEqual(new Set(allowed));
  });
});

describe('pagination', () => {
  it('pages are stable and sum to the whole', async () => {
    const api = await t.as('maker.all');
    const seen = [];
    for (let p = 1; p < 50; p++) {
      const r = await api.get(`/jobs?view=all&page=${p}&page_size=25`);
      seen.push(...r.body.items.map((i) => i.id));
      if (!r.body.has_more) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    const { rows: [n] } = await pool.query('SELECT count(*)::int AS n FROM jobs');
    expect(seen.length).toBe(n.n); // Maker-for-all holds a global view
  });
});

describe('parser service account', () => {
  it('can create and update jobs', async () => {
    const parser = await t.as('parser');
    const body = { ref: 'T-PARSE-1', client_id: t.C.acme, branch_id: t.B.delhi, direction: 'export', mode: 'lcl', internal_notes: 'from email' };
    const c = await parser.post('/parser/jobs', body);
    expect(c.body.results[0]).toMatchObject({ status: 201, created: true });
    const u = await parser.post('/parser/jobs', { ...body, mode: 'fcl' });
    expect(u.body.results[0]).toMatchObject({ status: 200, created: false });
    const { rows: [j] } = await pool.query(`SELECT mode, stage FROM jobs WHERE ref = 'T-PARSE-1'`);
    expect(j).toEqual({ mode: 'fcl', stage: 'Confirmed' });
  });
  it('cannot prepare, check, file, cancel or reopen', async () => {
    const parser = await t.as('parser');
    const { rows: jobs } = await pool.query(`SELECT DISTINCT ON (stage) id, stage FROM jobs WHERE stage IN ('Confirmed','Prepared','Checked','Filed') ORDER BY stage, id`);
    for (const stage of ['Confirmed', 'Prepared', 'Checked', 'Filed']) {
      const j = jobs.find((x) => x.stage === stage);
      for (const action of ['prepare', 'check', 'file', 'cancel', 'reopen']) {
        expect((await parser.post(`/jobs/${j.id}/actions`, { action, reason: 'automated' })).status).toBe(403);
      }
    }
  });
  it('cannot touch Filed jobs and cannot see jobs', async () => {
    const parser = await t.as('parser');
    const { rows: [f] } = await pool.query(`SELECT * FROM jobs WHERE stage = 'Filed' LIMIT 1`);
    const r = await parser.post('/parser/jobs', { ref: f.ref, client_id: f.client_id, branch_id: f.branch_id, direction: f.direction, mode: f.direction === 'import' ? 'air' : 'fcl' });
    expect(r.status).toBe(207);
    expect(r.body.results[0].status).toBe(403);
    expect((await pool.query('SELECT mode FROM jobs WHERE id = $1', [f.id])).rows[0].mode).toBe(f.mode);
    expect((await parser.get('/jobs?view=all')).body.items).toHaveLength(0);
  });
  it('a human without the parser grant cannot use the parser endpoint', async () => {
    const r = await (await t.as('maker.mum')).post('/parser/jobs', { ref: 'T-HACK', client_id: t.C.acme, branch_id: t.B.mumbai, direction: 'import', mode: 'air' });
    expect(r.body.results[0].status).toBe(403);
    expect((await pool.query(`SELECT 1 FROM jobs WHERE ref = 'T-HACK'`)).rows).toHaveLength(0);
  });
});
