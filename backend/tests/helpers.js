import request from 'supertest';
import { seedBase } from '../db/seed.js';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { config } from '../src/config.js';

export const PW = 'Demo@1234';

/** Re-seed the TEST schema and return helpers. Refuses to run against the real schema. */
export async function boot() {
  if (config.schema === 'nfpl') throw new Error('Refusing to run tests against the real schema');
  const seeded = await seedBase({ log: () => {} });
  const app = createApp();
  const tokens = {};
  const as = async (key) => {
    if (!tokens[key]) {
      const r = await request(app).post('/auth/login').send({ email: `${key}@nfpl.test`, password: PW });
      if (r.status !== 200) throw new Error(`login failed for ${key}`);
      tokens[key] = r.body.token;
    }
    const t = tokens[key];
    return {
      get: (p) => request(app).get(p).set('Authorization', `Bearer ${t}`),
      post: (p, b = {}) => request(app).post(p).set('Authorization', `Bearer ${t}`).send(b),
    };
  };
  return { ...seeded, app, as, uid: (k) => seeded.U[k], jid: (ref) => seeded.ids.get(ref) };
}

export const count = async (sql, params = []) => (await pool.query(sql, params)).rows[0].n;
export const auditCount = (where, params = []) => count(`SELECT count(*)::int AS n FROM audit_log WHERE ${where}`, params);
export { pool };
