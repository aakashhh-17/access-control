import { useEffect, useState } from 'react';
import { api, errMsg } from '../api.js';

export const STAGE_STYLE = {
  Confirmed: 'bg-slate-100 text-slate-700', Prepared: 'bg-blue-100 text-blue-800', Checked: 'bg-indigo-100 text-indigo-800',
  Filed: 'bg-green-100 text-green-800', Cancelled: 'bg-red-100 text-red-800', Reopened: 'bg-amber-100 text-amber-800',
};
export const StageBadge = ({ stage }) => <span className={`rounded px-2 py-0.5 text-xs font-medium ${STAGE_STYLE[stage] ?? 'bg-slate-100'}`}>{stage}</span>;

export default function Dashboard({ me, open }) {
  const [tab, setTab] = useState('waiting');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [count, setCount] = useState(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');

  useEffect(() => { api.get('/jobs/waiting/count').then((r) => setCount(r.data.count)).catch(() => {}); }, []);
  useEffect(() => {
    let live = true;
    setData(null); setError('');
    api.get('/jobs', { params: { view: tab, page, page_size: 20, q: q || undefined } })
      .then((r) => live && setData(r.data)).catch((e) => live && setError(errMsg(e)));
    return () => { live = false; };
  }, [tab, page, q]);

  const pick = (t) => { setTab(t); setPage(1); };
  const tabCls = (t) => `border-b-2 px-4 py-2 text-sm ${tab === t ? 'border-slate-900 font-medium' : 'border-transparent text-slate-500 hover:text-slate-800'}`;

  return (
    <div>
      <div className="flex items-end justify-between">
        <h1 className="text-xl font-semibold">{me.user.user_type === 'client' ? 'Your shipments' : 'Jobs'}</h1>
        {count !== null && <p className="text-sm text-slate-500">Waiting for you: <b className="text-slate-900">{count}</b></p>}
      </div>
      <div className="mt-3 flex border-b">
        <button className={tabCls('waiting')} onClick={() => pick('waiting')}>Waiting for me{count !== null && <span className="ml-2 rounded-full bg-slate-900 px-2 text-xs text-white">{count}</span>}</button>
        <button className={tabCls('all')} onClick={() => pick('all')}>All I can see</button>
      </div>
      <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search job ref, e.g. DEMO-CONFLICT" className="mt-3 w-full max-w-sm rounded border px-3 py-1.5 text-sm" />
      {error && <p className="mt-4 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!data && !error && <p className="mt-6 text-slate-500">Loading…</p>}
      {data && (
        <>
          <div className="mt-4 overflow-x-auto rounded-lg border bg-white">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr><th className="px-3 py-2">Job</th><th className="px-3 py-2">Client</th><th className="px-3 py-2">Branch</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Stage</th><th className="px-3 py-2">Updated</th></tr>
              </thead>
              <tbody>
                {data.items.map((j) => (
                  <tr key={j.id} onClick={() => open(j.id)} className="cursor-pointer border-t hover:bg-slate-50">
                    <td className="px-3 py-2 font-medium">{j.ref}{j.is_mine && <span className="ml-2 rounded bg-amber-100 px-1.5 text-xs text-amber-800">mine</span>}</td>
                    <td className="px-3 py-2">{j.client_name}</td>
                    <td className="px-3 py-2">{j.branch_name}</td>
                    <td className="px-3 py-2 capitalize">{j.direction} · {j.mode.toUpperCase()}</td>
                    <td className="px-3 py-2"><StageBadge stage={j.stage} /></td>
                    <td className="px-3 py-2 text-slate-500">{new Date(j.updated_at).toLocaleDateString()}</td>
                  </tr>
                ))}
                {!data.items.length && <tr><td colSpan="6" className="px-3 py-8 text-center text-slate-500">{tab === 'waiting' ? 'Nothing is waiting for you.' : 'No jobs visible to you.'}</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-between text-sm text-slate-600">
            <span>Page {data.page}{data.total !== undefined && ` · ${data.total} waiting in total (same query as the badge)`}</span>
            <span className="space-x-2">
              <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded border px-3 py-1 disabled:opacity-40">Prev</button>
              <button disabled={!data.has_more} onClick={() => setPage(page + 1)} className="rounded border px-3 py-1 disabled:opacity-40">Next</button>
            </span>
          </div>
        </>
      )}
    </div>
  );
}
