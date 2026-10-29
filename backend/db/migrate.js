import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pool } from '../src/db.js';
import { config } from '../src/config.js';

const sqlPath = fileURLToPath(new URL('./schema.sql', import.meta.url));

/** Create (optionally recreate) the schema and apply schema.sql. */
export async function migrate({ reset = false } = {}) {
  if (reset) await pool.query(`DROP SCHEMA IF EXISTS ${config.schema} CASCADE`);
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${config.schema}`);
  await pool.query(readFileSync(sqlPath, 'utf8'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reset = process.argv.includes('--reset');
  migrate({ reset })
    .then(() => console.log(`schema "${config.schema}" ready${reset ? ' (reset)' : ''}`))
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => pool.end());
}
