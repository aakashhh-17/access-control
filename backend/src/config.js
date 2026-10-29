import 'dotenv/config';

const schema = process.env.DB_SCHEMA || 'nfpl';
if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('DB_SCHEMA must be a simple lowercase identifier');

export const config = {
  databaseUrl: process.env.DATABASE_URL,
  schema,
  jwtSecret: process.env.JWT_SECRET || 'dev-only-secret',
  jwtExpiry: '8h',
  port: Number(process.env.PORT || 4000),
  demoPassword: process.env.DEMO_PASSWORD || 'Demo@1234',
};
