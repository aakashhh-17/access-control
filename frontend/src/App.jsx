import { useCallback, useEffect, useState } from 'react';
import { api, getToken, setToken, setOnUnauthorized, DEMO_PASSWORD } from './api.js';
import Login from './components/Login.jsx';
import Dashboard from './components/Dashboard.jsx';
import JobDetail from './components/JobDetail.jsx';
import GrantsAdmin from './components/GrantsAdmin.jsx';

export default function App() {
  const [me, setMe] = useState(null);
  const [booting, setBooting] = useState(!!getToken());
  const [view, setView] = useState({ name: 'dashboard' });
  const [demoUsers, setDemoUsers] = useState([]);

  const loadMe = useCallback(async () => {
    try { setMe((await api.get('/me')).data); }
    catch { setToken(null); setMe(null); }
    finally { setBooting(false); }
  }, []);

  useEffect(() => {
    setOnUnauthorized(() => { setToken(null); setMe(null); });
    api.get('/auth/demo-users').then((r) => setDemoUsers(r.data)).catch(() => {});
    if (getToken()) loadMe();
  }, [loadMe]);

  const login = async (email, password) => {
    const { data } = await api.post('/auth/login', { email, password });
    setToken(data.token);
    setView({ name: 'dashboard' });
    await loadMe();
  };
  const logout = () => { setToken(null); setMe(null); };

  if (booting) return <div className="p-8 text-slate-500">Loading…</div>;
  if (!me) return <Login demoUsers={demoUsers} onLogin={login} />;

  const roles = [...new Set(me.grants.map((g) => (g.source === 'delegated' ? `${g.role} (delegated)` : g.role)))];
  return (
    <div className="min-h-screen">
      <header className="bg-slate-900 text-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3">
          <span className="font-semibold tracking-tight">NFPL Access Control</span>
          <nav className="flex gap-1 text-sm">
            <button onClick={() => setView({ name: 'dashboard' })} className={`rounded px-3 py-1 ${view.name !== 'grants' ? 'bg-slate-700' : 'hover:bg-slate-800'}`}>Jobs</button>
            {me.can_manage_grants && (
              <button onClick={() => setView({ name: 'grants' })} className={`rounded px-3 py-1 ${view.name === 'grants' ? 'bg-slate-700' : 'hover:bg-slate-800'}`}>Grants</button>
            )}
          </nav>
          <div className="ml-auto flex flex-wrap items-center gap-3 text-sm">
            <span className="text-slate-300">{me.user.name} · {roles.join(', ') || 'no roles'}</span>
            <select
              aria-label="Switch demo user"
              className="rounded bg-slate-800 px-2 py-1 text-slate-100"
              value={me.user.email}
              onChange={(e) => login(e.target.value, DEMO_PASSWORD).catch(() => {})}
            >
              {!demoUsers.some((u) => u.email === me.user.email) && <option value={me.user.email}>{me.user.email}</option>}
              {demoUsers.map((u) => <option key={u.email} value={u.email}>{u.name} ({u.email.split('@')[0]})</option>)}
            </select>
            <button onClick={logout} className="rounded border border-slate-600 px-2 py-1 hover:bg-slate-800">Log out</button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        {view.name === 'grants' && <GrantsAdmin me={me} />}
        {view.name === 'job' && <JobDetail key={`${view.id}-${me.user.id}`} id={view.id} me={me} back={() => setView({ name: 'dashboard' })} />}
        {view.name === 'dashboard' && <Dashboard key={me.user.id} me={me} open={(id) => setView({ name: 'job', id })} />}
      </main>
    </div>
  );
}
