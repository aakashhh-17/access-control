import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { boot, pool, auditCount } from './helpers.js';

let t;
beforeAll(async () => { t = await boot(); });
afterAll(() => pool.end());

const act = async (who, id, body) => (await t.as(who)).post(`/jobs/${id}/actions`, body);
const jobRow = async (id) => (await pool.query('SELECT * FROM jobs WHERE id = $1', [id])).rows[0];

describe('happy path through the stages', () => {
  it('parser creates, maker prepares, checker checks, filer files - each audited with its grant', async () => {
    const parser = await t.as('parser');
    const c = await parser.post('/parser/jobs', { ref: 'T-FLOW-1', client_id: t.C.acme, branch_id: t.B.mumbai, direction: 'import', mode: 'air' });
    expect(c.status).toBe(200);
    const id = c.body.results[0].id;
    expect((await act('maker.mum', id, { action: 'prepare' })).status).toBe(200);
    expect((await act('maker.mum', id, { action: 'check' })).status).toBe(403);      // wrong stage-permission
    expect((await act('checker.all', id, { action: 'check' })).status).toBe(200);
    expect((await act('checker.all', id, { action: 'file' })).status).toBe(403);     // checker has no file permission
    expect((await act('filer.mum', id, { action: 'file' })).status).toBe(200);
    const j = await jobRow(id);
    expect(j).toMatchObject({ stage: 'Filed', prepared_by: t.uid('maker.mum'), checked_by: t.uid('checker.all'), filed_by: t.uid('filer.mum') });
    const { rows } = await pool.query(`SELECT action, actor_id, matched_grant_id FROM audit_log WHERE job_id = $1 AND decision = 'ALLOW' ORDER BY id`, [id]);
    expect(rows.map((r) => r.action)).toEqual(['job.create', 'prepare', 'check', 'file']);
    expect(rows.slice(1).every((r) => r.matched_grant_id)).toBe(true);
    expect(rows[0].actor_id).toBe(t.uid('parser')); // actor = parser
  });
});

describe('cancel / reopen of a FILED job', () => {
  const ref = 'NFPL-DEMO-FILED';
  it('branch manager lacks Supervisor-level authority', async () => {
    const r = await act('bm.mumbai', t.jid(ref), { action: 'cancel', reason: 'client asked' });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/job\.cancel_filed/);
  });
  it('reason is mandatory even for a Supervisor', async () => {
    const r = await act('super', t.jid(ref), { action: 'cancel' });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/requires a reason/);
    expect((await jobRow(t.jid(ref))).stage).toBe('Filed');
  });
  it('Supervisor cancels with a reason; reason is stored in the audit log', async () => {
    const r = await act('super', t.jid(ref), { action: 'cancel', reason: 'Client withdrew shipment' });
    expect(r.status).toBe(200);
    expect(await jobRow(t.jid(ref))).toMatchObject({ stage: 'Cancelled', cancelled_from_stage: 'Filed' });
    expect(await auditCount(`job_id = $1 AND action = 'cancel' AND decision = 'ALLOW' AND reason = 'Client withdrew shipment'`, [t.jid(ref)])).toBe(1);
  });
  it('reopening a job that was cancelled from Filed also needs Supervisor level + reason', async () => {
    expect((await act('bm.mumbai', t.jid(ref), { action: 'reopen', reason: 'try' })).status).toBe(403);
    expect((await act('super', t.jid(ref), { action: 'reopen' })).status).toBe(403);
    const ok = await act('super', t.jid(ref), { action: 'reopen', reason: 'Re-filing with corrected HS code' });
    expect(ok.status).toBe(200);
    expect(await jobRow(t.jid(ref))).toMatchObject({ stage: 'Reopened', prepared_by: null, checked_by: null, filed_by: null });
  });
  it('branch manager CAN cancel an unfiled job in their branch (but not another branch)', async () => {
    const { rows: [m] } = await pool.query(`SELECT id FROM jobs WHERE stage = 'Confirmed' AND branch_id = $1 LIMIT 1`, [t.B.mumbai]);
    const { rows: [d] } = await pool.query(`SELECT id FROM jobs WHERE stage = 'Confirmed' AND branch_id = $1 LIMIT 1`, [t.B.chennai]);
    expect((await act('bm.mumbai', d.id, { action: 'cancel', reason: 'not my branch' })).status).toBe(403);
    expect((await act('bm.mumbai', m.id, { action: 'cancel', reason: 'duplicate booking' })).status).toBe(200);
  });
});

describe('admin_fix', () => {
  it('needs a reason, works on a stuck job, and is always audited', async () => {
    const id = t.jid('NFPL-DEMO-EXPORT-NARROW'); // Prepared
    expect((await act('admin', id, { action: 'admin_fix', fix: { stage: 'Confirmed' } })).status).toBe(403); // no reason
    const r = await act('admin', id, { action: 'admin_fix', reason: 'Preparer left; resetting for re-prepare', fix: { stage: 'Confirmed' } });
    expect(r.status).toBe(200);
    expect(await jobRow(id)).toMatchObject({ stage: 'Confirmed', prepared_by: null });
    const { rows: [a] } = await pool.query(`SELECT * FROM audit_log WHERE job_id = $1 AND action = 'admin_fix' AND decision = 'ALLOW'`, [id]);
    expect(a).toMatchObject({ actor_id: t.uid('admin'), from_stage: 'Prepared', to_stage: 'Confirmed', reason: 'Preparer left; resetting for re-prepare' });
    expect(a.meta.before.stage).toBe('Prepared');
  });
  it('is refused on Filed jobs and for non-admins', async () => {
    const { rows: [f] } = await pool.query(`SELECT id FROM jobs WHERE stage = 'Filed' LIMIT 1`);
    expect((await act('admin', f.id, { action: 'admin_fix', reason: 'tamper', fix: { stage: 'Confirmed' } })).status).toBe(403);
    expect((await act('super', t.jid('NFPL-DEMO-ABSENT-2'), { action: 'admin_fix', reason: 'nope', fix: { stage: 'Confirmed' } })).status).toBe(403);
  });
  it('admin cannot work jobs themselves (no maker/checker/filer power)', async () => {
    expect((await act('admin', t.jid('NFPL-DEMO-ABSENT-2'), { action: 'prepare' })).status).toBe(403);
  });
});

describe('reassign (absent owner)', () => {
  it('branch manager reassigns within their branch, with a reason', async () => {
    const id = t.jid('NFPL-DEMO-ABSENT-1'); // Mumbai
    const bm = await t.as('bm.mumbai');
    expect((await bm.post(`/jobs/${id}/reassign`, { user_id: t.uid('cover.deleg') })).status).toBe(403); // no reason
    expect((await bm.post(`/jobs/${id}/reassign`, { user_id: t.uid('cover.deleg'), reason: 'Om on leave' })).status).toBe(200);
    expect((await jobRow(id)).responsible_user_id).toBe(t.uid('cover.deleg'));
    expect((await (await t.as('bm.delhi')).post(`/jobs/${id}/reassign`, { user_id: t.uid('maker.del'), reason: 'x y z' })).status).toBe(403);
  });
});

describe('concurrency', () => {
  it('two simultaneous prepares: exactly one wins (row lock)', async () => {
    const { rows: [j] } = await pool.query(`SELECT id FROM jobs WHERE stage = 'Confirmed' AND branch_id = $1 LIMIT 1`, [t.B.delhi]);
    const [a, b] = await Promise.all([act('maker.del', j.id, { action: 'prepare' }), act('maker.all', j.id, { action: 'prepare' })]);
    expect([a.status, b.status].sort()).toEqual([200, 403]);
  });
});
