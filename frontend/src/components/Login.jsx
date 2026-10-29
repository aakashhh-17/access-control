import { useState } from 'react';
import { errMsg, DEMO_PASSWORD } from '../api.js';

export default function Login({ demoUsers, onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState(DEMO_PASSWORD);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { await onLogin(email, password); } catch (err) { setError(errMsg(err)); } finally { setBusy(false); }
  };

  return (
    <div className="mx-auto mt-16 max-w-md rounded-lg border bg-white p-6 shadow-sm">
      <h1 className="text-xl font-semibold">NFPL Access Control</h1>
      <p className="mt-1 text-sm text-slate-500">Demo sign-in. Pick a seeded person or type an email. Demo password: <code className="rounded bg-slate-100 px-1">{DEMO_PASSWORD}</code></p>
      <form onSubmit={submit} className="mt-5 space-y-3">
        <label className="block text-sm">Demo user
          <select className="mt-1 w-full rounded border px-2 py-2" value={email} onChange={(e) => setEmail(e.target.value)}>
            <option value="">Select…</option>
            {demoUsers.map((u) => <option key={u.email} value={u.email}>{u.name} — {u.email}</option>)}
          </select>
        </label>
        <label className="block text-sm">Email
          <input className="mt-1 w-full rounded border px-2 py-2" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@nfpl.test" />
        </label>
        <label className="block text-sm">Password
          <input type="password" className="mt-1 w-full rounded border px-2 py-2" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <button disabled={busy || !email} className="w-full rounded bg-slate-900 py-2 text-white disabled:opacity-50">{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
