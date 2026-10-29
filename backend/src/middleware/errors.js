export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Express 4 does not catch async errors; wrap every async handler. */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
  if (err?.code === '23505') return res.status(409).json({ error: 'Already exists' });
  if (err?.code === '23503') return res.status(400).json({ error: 'Referenced record does not exist' });
  if (err?.code === '23514' || err?.code === '22P02' || err?.code === '22007') return res.status(400).json({ error: 'Invalid value', detail: err.message });
  if (err?.code === 'P0001') return res.status(403).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Internal error' });
}
