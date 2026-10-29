import axios from 'axios';

export const api = axios.create({ baseURL: import.meta.env.VITE_API_URL || 'http://localhost:4000' });

// Token lives in sessionStorage (per tab). Wrapped: storage can throw in private windows.
let token = null;
try { token = sessionStorage.getItem('token'); } catch { /* ignore */ }
export const getToken = () => token;
export const setToken = (t) => {
  token = t;
  try { t ? sessionStorage.setItem('token', t) : sessionStorage.removeItem('token'); } catch { /* ignore */ }
};

let onUnauthorized = () => {};
export const setOnUnauthorized = (fn) => { onUnauthorized = fn; };

api.interceptors.request.use((c) => { if (token) c.headers.Authorization = `Bearer ${token}`; return c; });
api.interceptors.response.use((r) => r, (e) => {
  if (e.response?.status === 401 && token) onUnauthorized(); // expired / deactivated
  return Promise.reject(e);
});

export const errMsg = (e) => e.response?.data?.error || e.message || 'Something went wrong';
export const DEMO_PASSWORD = 'Demo@1234';
