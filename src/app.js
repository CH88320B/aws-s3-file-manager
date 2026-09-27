const express = require('express');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { AppError } = require('./files');
const logger = require('./logger');

const uploadSchema = z.object({
  name: z.string().trim().min(1).max(255).refine((n) => !/[\\/\0]/.test(n), 'Name cannot contain slashes'),
  contentType: z.string().min(3).max(120),
  size: z.number().int().positive(),
});

const idSchema = z.string().uuid();

function createApp({ files, jwtSecret }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // Tokens come from your identity provider; only the subject (user id) is needed here.
  app.use('/api', (req, _res, next) => {
    const [scheme, token] = (req.get('authorization') || '').split(' ');
    if (scheme !== 'Bearer' || !token) return next(new AppError(401, 'Missing bearer token'));
    try {
      req.userId = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] }).sub;
      return req.userId ? next() : next(new AppError(401, 'Token has no subject'));
    } catch {
      return next(new AppError(401, 'Invalid or expired token'));
    }
  });

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const id = (req) => {
    const parsed = idSchema.safeParse(req.params.id);
    if (!parsed.success) throw new AppError(400, 'Invalid file id');
    return parsed.data;
  };

  app.post('/api/files/uploads', wrap(async (req, res) => {
    const parsed = uploadSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    res.status(201).json(await files.requestUpload(req.userId, parsed.data));
  }));

  app.post('/api/files/:id/complete', wrap(async (req, res) => res.json(await files.completeUpload(req.userId, id(req)))));

  app.get('/api/files', wrap(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const search = typeof req.query.search === 'string' && req.query.search.trim() ? req.query.search.trim().slice(0, 100) : null;
    res.json({ items: files.list(req.userId, { search, limit, offset }) });
  }));

  app.get('/api/files/:id/download', wrap(async (req, res) => res.json(await files.downloadUrl(req.userId, id(req)))));

  app.delete('/api/files/:id', wrap(async (req, res) => {
    await files.remove(req.userId, id(req));
    res.status(204).end();
  }));

  app.get('/api/usage', (req, res) => res.json(files.usage(req.userId)));

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    logger.error({ err, path: req.path }, 'unhandled error');
    return res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
