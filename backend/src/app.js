import express from 'express';
import cors from 'cors';
import { errorHandler } from './middleware/errors.js';
import authRoutes from './routes/auth.js';
import jobRoutes from './routes/jobs.js';
import grantRoutes from './routes/grants.js';
import delegationRoutes from './routes/delegations.js';
import parserRoutes from './routes/parser.js';

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use('/', authRoutes);
  app.use('/jobs', jobRoutes);
  app.use('/grants', grantRoutes);
  app.use('/delegations', delegationRoutes);
  app.use('/parser', parserRoutes);
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(errorHandler);
  return app;
}
