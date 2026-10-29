import { useCallback, useEffect, useState } from 'react';
import { api, errMsg } from '../api.js';

const STATUS = { active: 'bg-green-100 text-green-800', revoked: 'bg-red-100 text-red-800', expired: 'bg-slate-200 text-slate-700', scheduled: 'bg-blue-100 text-blue-800' };
const blank = { user_id: '', role: '', client_id: '', branch_id: '', direction: '', mode: '', valid_to: '' };

export default function GrantsAdmin({ me }) {
  const [meta, setMeta] = useState(null);
  const [grants, setGrants] = useState([]);
  const [form, setForm] = useState(blank);
  const [msg, setMsg] = useState(null); // {ok, text}
  const [onlyActive, setOnlyActive] = useState(true);

  const load = useCallback(async () => {
    try {
      const [m, g] = await Promise.all([api.get('/grants/meta'), api.get('/grants', { params: onlyActive ? { active: 1 } : {} })]);
      setMeta(m.data); setGrants(g.data);
    } catch (e) { setMsg({ ok: false, text: errMsg(e) }); }
  }, [onlyActive]);
  useEffect(() => { load(); }, [load]);

  const post = async (payload, okText) => {
    setMsg(null);
    try { await api.post('/grants', payload); setMsg({ ok: true, text: okText }); setForm(blank); }
    catch (e) { setMsg({ ok: false, text: errMsg(e), blocked: e.response?.status === 403 }); }
    load();
  };
  const submit = (e) => {
    e.preventDefault();
    const n = (v) => (v === '' ? null : Number(v));
    post({ user_id: Number(form.user_id), role: form.role, client_id: n(form.client_id), branch_id: n(form.branch_id),
      direction: form.direction || null, mode: form.mode || null, valid_to: form.valid_to ? new Date(form.valid_to).toISOString() : null }, 'Grant created');
  };
  const revoke = async (id) => {
    setMsg(null);
    try { await api.post(`/grants/${id}/revoke`); setMsg({ ok: true, text: `Grant #${id} revoked. Effective immediately.` }); }
    catch (e) { setMsg({ ok: false, text: errMsg(e) }); }
    load();
  };
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  if (!meta) return <p className="text-slate-500">{msg ? msg.text : 'Loading…'}</p>;
  const sel = 'mt-1 w-full rounded border px-2 py-1.5 text-sm';

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Grants</h1>
      {msg && (
        <p className={`rounded px-3 py-2 text-sm ${msg.ok ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700'}`}>
          {msg.blocked && <b>Blocked and logged: </b>}{msg.text}
        </p>
      )}
      <form onSubmit={submit} className="grid gap-3 rounded-lg border bg-white p-5 md:grid-cols-4">
        <label className="text-xs uppercase text-slate-500">Person
          <select required className={sel} value={form.user_id} onChange={set('user_id')}>
            <option value="">Select…</option>{meta.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select></label>
        <label className="text-xs uppercase text-slate-500">Role
          <select required className={sel} value={form.role} onChange={set('role')}>
            <option value="">Select…</option>{meta.roles.map((r) => <option key={r.name} value={r.name} disabled={!meta.grantable_roles.includes(r.name)}>{r.name}{meta.grantable_roles.includes(r.name) ? '' : ' (not grantable by you)'}</option>)}
          </select></label>
        <label className="text-xs uppercase text-slate-500">Client
          <select className={sel} value={form.client_id} onChange={set('client_id')}><option value="">All clients</option>{meta.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="text-xs uppercase text-slate-500">Branch
          <select className={sel} value={form.branch_id} onChange={set('branch_id')}><option value="">All branches</option>{meta.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
        <label className="text-xs uppercase text-slate-500">Direction
          <select className={sel} value={form.direction} onChange={set('direction')}><option value="">Import + export</option><option value="import">Import only</option><option value="export">Export only</option></select></label>
        <label className="text-xs uppercase text-slate-500">Mode
          <select className={sel} value={form.mode} onChange={set('mode')}><option value="">All modes</option><option value="air">Air</option><option value="fcl">FCL</option><option value="lcl">LCL</option></select></label>
        <label className="text-xs uppercase text-slate-500">Valid until (optional)
          <input type="date" className={sel} value={form.valid_to} onChange={set('valid_to')} /></label>
        <div className="flex items-end gap-2">
          <button className="rounded bg-slate-900 px-4 py-1.5 text-sm text-white">Add grant</button>
          <button type="button" onClick={() => post({ user_id: me.user.id, role: 'Maker' }, 'unexpected: created')} className="rounded border border-red-300 px-3 py-1.5 text-xs text-red-700" title="Demo: attempt self-escalation">Try granting myself Maker</button>
        </div>
      </form>

      <div>
        <label className="text-sm"><input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} /> Active only</label>
        <div className="mt-2 overflow-x-auto rounded-lg border bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>
              <th className="px-3 py-2">#</th><th className="px-3 py-2">Person</th><th className="px-3 py-2">Role</th><th className="px-3 py-2">Scope</th><th className="px-3 py-2">Valid</th><th className="px-3 py-2">Status</th><th className="px-3 py-2" /></tr></thead>
            <tbody>
              {grants.map((g) => (
                <tr key={g.id} className="border-t">
                  <td className="px-3 py-2 text-slate-400">{g.id}</td>
                  <td className="px-3 py-2">{g.user_name}</td>
                  <td className="px-3 py-2 font-medium">{g.role}</td>
                  <td className="px-3 py-2 text-xs">{[g.client_name ?? 'all clients', g.branch_name ?? 'all branches', g.direction ?? 'imp+exp', g.mode ?? 'all modes'].join(' · ')}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{new Date(g.valid_from).toLocaleDateString()} → {g.valid_to ? new Date(g.valid_to).toLocaleDateString() : 'open'}{g.revoked_at && ` (revoked ${new Date(g.revoked_at).toLocaleDateString()})`}</td>
                  <td className="px-3 py-2"><span className={`rounded px-2 py-0.5 text-xs ${STATUS[g.status]}`}>{g.status}</span></td>
                  <td className="px-3 py-2 text-right">{g.status === 'active' && <button onClick={() => revoke(g.id)} className="rounded border px-2 py-1 text-xs text-red-700 hover:bg-red-50">Revoke</button>}</td>
                </tr>
              ))}
              {!grants.length && <tr><td colSpan="7" className="px-3 py-6 text-center text-slate-500">No grants in your scope.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
