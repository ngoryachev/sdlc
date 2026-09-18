import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { serveStatic } from '@hono/node-server/serve-static';
import type { App } from '../app.js';
import { HttpError } from '../engine/engine.js';
import { saveConfig, sdlcRoot } from '../config/config.js';
import { sseHandler } from './sse.js';
import { tasksRoutes } from './routes/tasks.js';
import { hilRoutes } from './routes/hil.js';
import { configRoutes } from './routes/config.js';
import { reposRoutes } from './routes/repos.js';

export function ensureToken(app: App): string {
  if (!app.config.server.token) {
    app.config.server.token = crypto.randomBytes(24).toString('base64url');
    try { saveConfig(app.config); } catch (e) { console.error('[sdlc] could not persist token to config:', e); }
  }
  return app.config.server.token;
}

export function createHttpApp(app: App) {
  const token = ensureToken(app);
  const hono = new Hono();

  hono.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message, ...err.extra }, err.status as 400);
    console.error('[http]', err);
    return c.json({ error: err.message }, 500);
  });

  // token via ?t= sets the cookie and redirects; Bearer and cookie are accepted
  hono.use('*', async (c, next) => {
    const t = c.req.query('t');
    if (t && !app.config.server.token_in_url) return c.text('token login via URL is disabled on this server; paste the token in the login form', 403);
    if (t) {
      if (safeEq(t, token)) {
        setCookie(c, 'sdlc_token', t, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 60 * 60 * 24 * 30 });
        const u = new URL(c.req.url); u.searchParams.delete('t');
        return c.redirect(u.pathname + (u.search || ''));
      }
      return c.text('bad token', 401);
    }
    await next();
  });
  hono.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/health' || c.req.path === '/api/login') return next();
    const auth = c.req.header('authorization');
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    const cookie = getCookie(c, 'sdlc_token');
    if ((bearer && safeEq(bearer, token)) || (cookie && safeEq(cookie, token))) return next();
    return c.json({ error: 'unauthorized' }, 401);
  });

  hono.get('/api/health', (c) => c.json({ ok: true, version: '0.1.0' }));
  // login form: POST the token once, get the cookie (works with token_in_url: false)
  hono.post('/api/login', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { token?: string };
    if (!body.token || !safeEq(body.token, token)) return c.json({ error: 'bad token' }, 401);
    setCookie(c, 'sdlc_token', body.token, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 60 * 60 * 24 * 30, secure: c.req.url.startsWith('https://') });
    return c.json({ ok: true });
  });
  hono.get('/api/events', sseHandler(app.events));
  hono.get('/api/events/last', (c) => c.json({ id: app.events.lastId() }));
  hono.get('/api/events/history', (c) => c.json({ events: app.events.replay(Number(c.req.query('since') ?? 0), c.req.query('taskId') || undefined, Number(c.req.query('limit') ?? 200)) }));
  hono.route('/api', tasksRoutes(app));
  hono.route('/api', hilRoutes(app));
  hono.route('/api', configRoutes(app));
  hono.route('/api', reposRoutes(app));

  // static UI (built) with SPA fallback
  const uiDist = path.join(sdlcRoot(), 'ui', 'dist');
  if (fs.existsSync(uiDist)) {
    hono.use('/*', serveStatic({ root: path.relative(process.cwd(), uiDist) || '.' }));
    hono.get('*', (c) => c.html(fs.readFileSync(path.join(uiDist, 'index.html'), 'utf8')));
  } else {
    hono.get('/', (c) => c.text('sdlc server is running; UI is not built (run npm -w ui run build). API at /api'));
  }
  return hono;
}

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
