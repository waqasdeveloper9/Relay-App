import type { NextFunction, Request, Response } from 'express';
import { jwtVerify, SignJWT } from 'jose';
import { config } from '../config.js';
import { getStore } from '../services/repository.js';
import type { Store } from '../models/types.js';

declare global {
  namespace Express {
    interface Request {
      merchantId: string;
      store: Store;
    }
  }
}
const key = new TextEncoder().encode(config.jwtSecret);
export async function issueToken(id: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(id)
    .setIssuer('relay')
    .setAudience('relay-dashboard')
    .setIssuedAt()
    .setExpirationTime('12h')
    .sign(key);
}
export function trustedLocalRequest(req: Request): boolean {
  const origin = req.get('origin') ?? `${req.protocol}://${req.get('host')}`;
  try {
    const url = new URL(origin);
    return (
      !req.secure &&
      ['127.0.0.1', 'localhost', '::1'].includes(req.hostname) &&
      url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      [new URL(config.appUrl).origin, ...config.allowedOrigins].includes(url.origin)
    );
  } catch {
    return false;
  }
}
export function setSession(res: Response, token: string, req?: Request): void {
  res.cookie('relay_session', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.appUrl.startsWith('https:') && !(req && trustedLocalRequest(req)),
    maxAge: 12 * 60 * 60 * 1000,
    path: '/api',
  });
}
export async function auth(req: Request, res: Response, next: NextFunction): Promise<void> {
  let merchantId: string;
  try {
    const cookies = Object.fromEntries(
      (req.headers.cookie ?? '')
        .split(';')
        .filter(Boolean)
        .map((c) => {
          const i = c.indexOf('=');
          return [c.slice(0, i).trim(), c.slice(i + 1)];
        }),
    );
    const { payload } = await jwtVerify(cookies.relay_session ?? '', key, {
      issuer: 'relay',
      audience: 'relay-dashboard',
      algorithms: ['HS256'],
    });
    merchantId = payload.sub ?? '';
  } catch {
    res.status(401).json({ error: 'Please sign in to continue.' });
    return;
  }
  try {
    const store = await getStore(merchantId);
    if (!store) {
      res.status(401).json({ error: 'Your session has expired. Please sign in.' });
      return;
    }
    req.merchantId = store.merchant.id;
    req.store = store;
    next();
  } catch {
    res
      .status(503)
      .json({
        error: 'The database is temporarily unavailable. Your session is retained; retry shortly.',
      });
  }
}
