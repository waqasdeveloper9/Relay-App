import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { ZodError } from 'zod';
import { config } from './config.js';
import { api } from './routes/api.js';
import { meta, metaChallenge, shopify } from './controllers/webhooks.js';
import { ConflictError } from './services/repository.js';
import { ProviderError } from './services/providers.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          upgradeInsecureRequests: config.appUrl.startsWith('https:') ? [] : null,
        },
      },
    }),
  );
  app.get('/api/webhooks/meta', metaChallenge);
  app.get('/api/webhooks/meta/:merchantId', metaChallenge);
  app.post(
    '/api/webhooks/meta/:merchantId',
    express.raw({ type: 'application/json', limit: '1mb' }),
    meta,
  );
  app.post(
    '/api/webhooks/shopify',
    express.raw({ type: 'application/json', limit: '1mb' }),
    shopify,
  );
  app.post('/api/webhooks/meta', express.raw({ type: 'application/json', limit: '1mb' }), meta);
  app.use(
    '/api',
    rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: 'draft-7', legacyHeaders: false }),
  );
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      next();
      return;
    }
    const origin = req.get('origin');
    if (origin && ![new URL(config.appUrl).origin, ...config.allowedOrigins].includes(origin)) {
      res.status(403).json({ error: 'Request origin is not allowed' });
      return;
    }
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'Use application/json' });
      return;
    }
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  app.use('/api', api);
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
  });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof ZodError) {
      res
        .status(400)
        .json({ error: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
      return;
    }
    if (error instanceof ConflictError) {
      res.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof ProviderError) {
      res.status(502).json({ error: error.message });
      return;
    }
    const status =
      error && typeof error === 'object' && 'status' in error
        ? Number(error.status)
        : error instanceof SyntaxError
          ? 400
          : 500;
    if (status >= 500)
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'request_failed',
          type: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
    res.status(status >= 400 && status <= 599 ? status : 500).json({
      error:
        status < 500 && error instanceof Error
          ? error.message
          : 'The operation could not be completed. Check server logs and try again.',
    });
  };
  app.use(errors);
  return app;
}
