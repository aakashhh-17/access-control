import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { boot, pool, auditCount, count } from './helpers.js';

let t;
beforeAll(async () => { t = await boot(); });
afterAll(() => pool.end());

describe('admin self-escalation', () => {
  it('is blocked, nothing is created, and the attempt is audited', async () => {
    const admin = await t.as('admin');
    const grantsBefore = await count('SELECT count(*)::int AS n FROM grants');
    const auditBefore = await auditCount(`action = 'grant.create' AND decision = 'DENY' AND actor_id = $1`, [t.uid('admin')]);
    const r = await admin.post('/grants', { user_id: t.uid('admin'), role: 'Maker' });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/Self-escalation blocked/);
    expect(await count('SELECT count(*)::int AS n FROM grants')).toBe(grantsBefore);
    expect(await auditCount(`action = 'grant.create' AND decision = 'DENY' AND actor_id = $1`, [t.uid('admin')])).toBe(auditBefore + 1);
  });
  it('the database itself rejects a self-grant (backstop)', async () => {
    await expect(pool.query(`INSERT INTO grants(user_id, role, created_by) VALUES ($1, 'Maker', $1)`, [t.uid('admin')])).rejects.toThrow();
  });
  it('admin cannot mint another Admin (outside grantable set)', async () => {
    const admin = await t.as('admin');
    const r = await admin.post('/grants', { user_id: t.uid('maker.mum'), role: 'Admin' });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/grantable set/);
  });
});

describe('who may grant what', () => {
  it('non-managers cannot manage grants', async () => {
    expect((await (await t.as('maker.mum')).post('/grants', { user_id: t.uid('maker.del'), role: 'Maker' })).status).toBe(403);
  });
  it('branch manager: Maker/Checker/Filer inside own branch only', async () => {
    const bm = await t.as('bm.mumbai');
    const mk = (role, branch_id) => bm.post('/grants', { user_id: t.uid('cover.deleg'), role, branch_id });
    expect((await mk('Maker', t.B.mumbai)).status).toBe(201);
    expect((await mk('Supervisor', t.B.mumbai)).status).toBe(403);   // role outside grantable set
    expect((await mk('Maker', t.B.delhi)).status).toBe(403);         // scope outside own branch
    expect((await mk('Maker', null)).status).toBe(403);              // "all branches" is wider than theirs
  });
  it('role must fit the user type', async () => {
    const admin = await t.as('admin');
    expect((await admin.post('/grants', { user_id: t.uid('client.acme'), role: 'Maker' })).status).toBe(400);
    expect((await admin.post('/grants', { user_id: t.uid('client.acme'), role: 'ClientUser', client_id: t.C.bharat })).status).toBe(400);
  });
  it('branch manager cannot revoke a global grant', async () => {
    const r = await (await t.as('bm.mumbai')).post(`/grants/${t.G['checker.all']}/revoke`);
    expect(r.status).toBe(403);
  });
});

describe('revocation is immediate and history survives', () => {
  it('same JWT, next request: access gone; queue and actions drop; audit + grant row preserved', async () => {
    const id = t.jid('NFPL-DEMO-ACME-PREP');
    const checker = await t.as('checker.all');
    const admin = await t.as('admin');
    const past = await auditCount(`actor_id = $1`, [t.uid('checker.all')]);
    expect((await checker.get(`/jobs/${id}/can?action=check`)).body.allowed).toBe(true);
    const before = (await checker.get('/jobs/waiting/count')).body.count;
    expect(before).toBeGreaterThan(0);

    const rv = await admin.post(`/grants/${t.G['checker.all']}/revoke`);
    expect(rv.status).toBe(200);

    expect((await checker.get(`/jobs/${id}/can?action=check`)).status).toBe(404); // job dropped out of their visibility too
    expect((await checker.post(`/jobs/${id}/actions`, { action: 'check' })).status).toBe(403);
    expect((await checker.get('/jobs/waiting/count')).body.count).toBe(0);
    expect((await checker.get('/jobs?view=waiting')).body.items).toHaveLength(0);

    const { rows: [g] } = await pool.query('SELECT * FROM grants WHERE id = $1', [t.G['checker.all']]);
    expect(g.revoked_at).not.toBeNull();
    expect(g.revoked_by).toBe(t.uid('admin'));
    expect(await auditCount(`actor_id = $1 AND decision = 'ALLOW'`, [t.uid('checker.all')])).toBeGreaterThanOrEqual(past > 0 ? 1 : 0);
    expect(await auditCount(`action = 'grant.revoke' AND matched_grant_id IS NOT NULL AND (meta->>'grant_id')::int = $1`, [t.G['checker.all']])).toBe(1);
    expect((await admin.post(`/grants/${t.G['checker.all']}/revoke`)).status).toBe(409);
  });
  it('a past action by the revoked grant stays in history', async () => {
    const { rows } = await pool.query(`SELECT 1 FROM audit_log WHERE job_id = $1 AND action = 'check' AND actor_id = $2 AND matched_grant_id = $3`,
      [t.jid('NFPL-DEMO-REVOKED-DONE'), t.uid('changed.grant'), t.G['changed.grant.old']]);
    expect(rows).toHaveLength(1);
  });
});

describe('append-only guarantees (database level)', () => {
  it('grants cannot be deleted, rescoped or un-revoked; audit cannot be changed or deleted', async () => {
    await expect(pool.query('DELETE FROM grants WHERE id = $1', [t.G['maker.all']])).rejects.toThrow(/never deleted/);
    await expect(pool.query(`UPDATE grants SET client_id = $2 WHERE id = $1`, [t.G['maker.all'], t.C.acme])).rejects.toThrow(/immutable/);
    await expect(pool.query('UPDATE grants SET revoked_at = NULL, revoked_by = NULL WHERE id = $1', [t.G['changed.grant.old']])).rejects.toThrow();
    await expect(pool.query(`UPDATE audit_log SET reason = 'x'`)).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
  });
});
