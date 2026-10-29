import pg from 'pg';
import { config } from './config.js';

if (!config.databaseUrl) throw new Error('DATABASE_URL is not set (see .env.example)');

// search_path is a startup option, so every connection works inside the configured schema
// (nfpl, or nfpl_test under tests). Requires a direct (non-pooled) Neon connection string.
export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10, options: `-c search_path=${config.schema}` });

export const query = (text, params) => pool.query(text, params);
