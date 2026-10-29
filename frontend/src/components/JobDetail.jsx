import { useCallback, useEffect, useState } from 'react';
import { api, errMsg } from '../api.js';
import { StageBadge } from './Dashboard.jsx';
import WhyPanel, { WhoPanel } from './WhyPanel.jsx';

const ACTIONS = [
  ['prepare', 'Prepare'], ['check', 'Check'], ['file', 'File'],
  ['cancel', 'Cancel job'], ['reopen', 'Reopen'], ['admin_fix', 'Admin fix'],
];
const FIX_STAGES = ['Confirmed', 'Prepared', 'Checked'];

const Field = ({ label, children }) => (
  <div><dt className="text-xs uppercase text-slate-500">{label}</dt><dd className="mt-0.5">{children || <span className="text-slate-400">-</span>}</dd></div>
);

export default function JobDetail({ id, me, back }) {
  const [data, setData] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(null); // {ok, text}
  const [pending, setPending] = useState(null); // action awaiting a reason
  const [reason, setReason] = useState('');
  const [fixStage, setFixStage] = useState('Confirmed');
  const [staff, setStaff] = useState([]);
  const [assignee, setAssignee] = useState('');

  const load = useCallback(async () => {
    try {
      const [j, h] = await Promise.all([api.get(`/jobs/${id}`), api.get(`/jobs/${id}/history`)]);
      setData(j.data); setHistory(h.data); setError('');
    } catch (e) { setError(errMsg(e)); }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (me.is_manager) api.get('/users').then((r) => setStaff(r.data)).catch(() => {}); }, [me.is_manager]);

  const run = async (action, extra = {}) => {
    setFlash(null);
    try {
      await api.post(`/jobs/${id}/actions`, { action, ...extra });
      setFlash({ ok: true, text: `${action} done` });
      setPending(null); setReason('');
    } catch (e) { setFlash({ ok: false, text: errMsg(e) }); }
    load();
  };
  const click = (action, meta) => {
    if (meta.requires_reason) { setPending(action); setReason(''); } else run(action);
  };
  const submitPending = () => run(pending, pending === 'admin_fix' ? { reason, fix: { stage: fixStage } } : { reason });
  const reassign = async () => {
    setFlash(null);
    try {
      await api.post(`/jobs/${id}/reassign`, { user_id: Number(assignee), reason });
      setFlash({ ok: true, text: 'Responsible person changed' }); setReason(''); setAssignee('');
    } catch (e) { setFlash({ ok: false, text: errMsg(e) }); }
    load();
  };

  if (error) return <div><button onClick={back} className="text-sm text-blue-700">← Back</button><p className="mt-4 rounded bg-red-50 px-3 py-2 text-red-700">{error}</p></div>;
  if (!data) return <p className="text-slate-500">Loading…</p>;
  const { job, actions } = data;

  return (
    <div className="space-y-6">
      <button onClick={back} className="text-sm text-blue-700 hover:underline">← Back to jobs</button>
      <section className="rounded-lg border bg-white p-5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{job.ref}</h1><StageBadge stage={job.stage} />
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
          <Field label="Client">{job.client_name}</Field>
          <Field label="Branch">{job.branch_name}</Field>
          <Field label="Direction / mode"><span className="capitalize">{job.direction}</span> · {job.mode.toUpperCase()}</Field>
          <Field label="Responsible">{job.responsible_name}</Field>
          <Field label="Prepared by">{job.prepared_by_name}</Field>
          <Field label="Checked by">{job.checked_by_name}</Field>
          <Field label="Filed by">{job.filed_by_name}</Field>
          <Field label="Cancelled from">{job.cancelled_from_stage}</Field>
        </dl>
        {'internal_notes' in job
          ? <p className="mt-4 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm"><b>Internal notes</b> (hidden from client users): {job.internal_notes}</p>
          : <p className="mt-4 text-xs text-slate-400">Internal notes are not visible to your role.</p>}
      </section>

      <section className="rounded-lg border bg-white p-5">
        <h2 className="font-semibold">Actions</h2>
        <p className="text-xs text-slate-500">Disabled buttons say exactly why. Same decision function the server enforces.</p>
        {flash && <p className={`mt-3 rounded px-3 py-2 text-sm ${flash.ok ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700'}`}>{flash.text}</p>}
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          {ACTIONS.map(([key, label]) => {
            const a = actions[key];
            return (
              <div key={key} className={`rounded border p-3 ${a.allowed ? 'border-slate-300' : 'bg-slate-50'}`}>
                <button disabled={!a.allowed} onClick={() => click(key, a)}
                  className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-300" title={a.reason}>{label}</button>
                <p className={`mt-2 text-xs ${a.allowed ? 'text-green-700' : 'text-slate-500'}`}>{a.reason}</p>
              </div>
            );
          })}
        </div>
        {pending && (
          <div className="mt-4 rounded border border-amber-300 bg-amber-50 p-3">
            <p className="text-sm font-medium">Reason required for “{pending}”</p>
            {pending === 'admin_fix' && (
              <label className="mt-2 block text-sm">Reset stage to
                <select className="ml-2 rounded border px-2 py-1" value={fixStage} onChange={(e) => setFixStage(e.target.value)}>{FIX_STAGES.map((s) => <option key={s}>{s}</option>)}</select>
              </label>
            )}
            <input className="mt-2 w-full rounded border px-2 py-1.5 text-sm" placeholder="Why? (stored in the audit log)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <div className="mt-2 space-x-2">
              <button onClick={submitPending} className="rounded bg-amber-600 px-3 py-1 text-sm text-white">Confirm {pending}</button>
              <button onClick={() => setPending(null)} className="rounded border px-3 py-1 text-sm">Never mind</button>
            </div>
          </div>
        )}
        {actions.reassign?.allowed && (
          <div className="mt-4 rounded border p-3 text-sm">
            <p className="font-medium">Reassign responsible person</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <select className="rounded border px-2 py-1" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">Select person…</option>{staff.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
              <input className="min-w-[14rem] flex-1 rounded border px-2 py-1" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
              <button disabled={!assignee || reason.length < 3} onClick={reassign} className="rounded bg-slate-900 px-3 py-1 text-white disabled:opacity-40">Reassign</button>
            </div>
          </div>
        )}
      </section>

      {me.is_manager && <WhyPanel job={job} staff={staff} me={me} />}
      {me.is_manager && <WhoPanel job={job} />}

      <section className="rounded-lg border bg-white p-5">
        <h2 className="font-semibold">History</h2>
        <ol className="mt-3 space-y-3 border-l-2 border-slate-200 pl-4">
          {history.map((h, i) => (
            <li key={h.id ?? i} className="relative text-sm">
              <span className={`absolute -left-[1.4rem] top-1.5 h-2.5 w-2.5 rounded-full ${h.decision === 'DENY' ? 'bg-red-500' : 'bg-slate-500'}`} />
              <div className="flex flex-wrap items-center gap-2">
                <b>{h.action}</b>
                {h.from_stage || h.to_stage ? <span className="text-slate-500">{h.from_stage ?? '·'} → {h.to_stage ?? '·'}</span> : null}
                {h.decision === 'DENY' && <span className="rounded bg-red-100 px-1.5 text-xs text-red-700">DENIED</span>}
                {h.actor_name && <span>by {h.actor_name}</span>}
                <span className="text-xs text-slate-400">{new Date(h.ts).toLocaleString()}</span>
              </div>
              {h.reason && <p className="text-slate-600">“{h.reason}”</p>}
              {h.matched_grant_id && <p className="text-xs text-slate-400">under grant #{h.matched_grant_id}{h.meta?.via_delegation ? ' (delegated)' : ''}</p>}
            </li>
          ))}
          {!history.length && <li className="text-sm text-slate-500">No history yet.</li>}
        </ol>
      </section>
    </div>
  );
}
