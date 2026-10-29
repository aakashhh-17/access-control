import { useState } from 'react';
import { api, errMsg } from '../api.js';

const NEXT = { Confirmed: 'prepare', Reopened: 'prepare', Prepared: 'check', Checked: 'file', Filed: 'cancel', Cancelled: 'reopen' };
const ACTIONS = ['prepare', 'check', 'file', 'cancel', 'reopen', 'admin_fix', 'reassign'];

function Column({ r }) {
  return (
    <div className={`rounded border p-3 ${r.allowed ? 'border-green-300 bg-green-50' : 'border-red-300 bg-red-50'}`}>
      <div className="flex items-center justify-between">
        <b>{r.user?.name ?? 'Unknown user'}</b>
        <span className={`rounded px-2 py-0.5 text-xs font-semibold ${r.allowed ? 'bg-green-600 text-white' : 'bg-red-600 text-white'}`}>{r.allowed ? 'CAN' : 'CANNOT'}</span>
      </div>
      <p className="mt-2 text-sm">{r.reason}</p>
      <ul className="mt-3 space-y-1 text-xs">
        {r.checks.map((c, i) => (
          <li key={i} className="flex gap-2"><span className={c.pass ? 'text-green-700' : 'text-red-700'}>{c.pass ? '✓' : '✗'}</span><span><b>{c.name}</b>: {c.detail}</span></li>
        ))}
      </ul>
    </div>
  );
}

function Select({ value, onChange, label, me, staff }) {
  return (
    <label className="text-sm">{label}
      <select className="ml-2 rounded border px-2 py-1" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">-</option>
        <option value={me.user.id}>Me ({me.user.name})</option>
        {staff.filter((u) => u.id !== me.user.id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
      </select>
    </label>
  );
}

export function WhoPanel({ job }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [r, setR] = useState(null);
  const [error, setError] = useState('');
  const go = async () => {
    setError('');
    try { setR((await api.get(`/jobs/${job.id}/who-could-have`, { params: { date } })).data); } catch (e) { setError(errMsg(e)); }
  };
  return (
    <section className="rounded-lg border bg-white p-5">
      <h2 className="font-semibold">Who could have changed this job on…?</h2>
      <p className="text-xs text-slate-500">Rebuilt from grants and delegations held on that (UTC) day, plus what actually happened.</p>
      <div className="mt-3 flex items-center gap-3">
        <input type="date" className="rounded border px-2 py-1 text-sm" value={date} onChange={(e) => setDate(e.target.value)} />
        <button onClick={go} className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white">Look up</button>
      </div>
      {error && <p className="mt-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {r && (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div>
            <p className="text-sm font-medium">Could have (job was {r.stage_at_end} at end of day)</p>
            <ul className="mt-2 space-y-1 text-sm">
              {r.could.map((c) => (
                <li key={c.user_id} className="rounded border px-2 py-1">
                  <b>{c.name}</b> <span className="text-xs text-slate-500">{c.permissions.map((p) => p.replace('job.', '')).join(', ')}</span>
                  <div className="text-xs text-slate-500">{c.via.map((v) => (v.type === 'grant' ? `${v.role} grant #${v.grant_id}${v.revoked_at ? ' (since revoked)' : ''}` : `delegated ${v.role} #${v.grant_id}`)).join('; ')}</div>
                </li>
              ))}
              {!r.could.length && <li className="text-slate-500">Nobody held authority.</li>}
            </ul>
          </div>
          <div>
            <p className="text-sm font-medium">Actually did</p>
            <ul className="mt-2 space-y-1 text-sm">
              {r.actually_did.map((a, i) => (
                <li key={i} className="rounded border px-2 py-1"><b>{a.action}</b> by {a.actor_name ?? 'system'} {a.decision === 'DENY' && <span className="text-red-600">(denied)</span>}
                  <div className="text-xs text-slate-500">{new Date(a.ts).toLocaleString()}</div></li>
              ))}
              {!r.actually_did.length && <li className="text-slate-500">No recorded activity that day.</li>}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}

export default function WhyPanel({ job, staff, me }) {
  const [action, setAction] = useState(NEXT[job.stage] ?? 'check');
  const [a, setA] = useState(String(me.user.id));
  const [b, setB] = useState('');
  const [results, setResults] = useState([]);
  const [error, setError] = useState('');

  const compare = async () => {
    setError('');
    try {
      const ids = [a, b].filter(Boolean);
      const out = await Promise.all(ids.map((u) => api.get(`/jobs/${job.id}/can`, { params: { action, user_id: u } }).then((r) => r.data)));
      setResults(out);
    } catch (e) { setError(errMsg(e)); }
  };
  return (
    <section className="rounded-lg border bg-white p-5">
      <h2 className="font-semibold">Why can she do this and he can't?</h2>
      <p className="text-xs text-slate-500">Pick an action and two people. Each side runs the real decision function and shows every check.</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="text-sm">Action
          <select className="ml-2 rounded border px-2 py-1" value={action} onChange={(e) => setAction(e.target.value)}>{ACTIONS.map((x) => <option key={x}>{x}</option>)}</select>
        </label>
        <Select label="Person A" value={a} onChange={setA} me={me} staff={staff} />
        <Select label="Person B" value={b} onChange={setB} me={me} staff={staff} />
        <button onClick={compare} disabled={!a && !b} className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-40">Compare</button>
      </div>
      {error && <p className="mt-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {results.length > 0 && <div className={`mt-4 grid gap-4 ${results.length > 1 ? 'md:grid-cols-2' : ''}`}>{results.map((r, i) => <Column key={i} r={r} />)}</div>}
    </section>
  );
}
