import http from 'node:http';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Service } from './service.ts';
import type { User } from './types.ts';
import { AppError, E } from './errors.ts';

export interface HttpOpts {
  corsOrigin?: string;            // one origin or a comma-separated list
  secureCookies?: boolean; trustProxy?: boolean; sameSite?: 'Lax' | 'Strict' | 'None';
  sharedRateLimit?: (key: string, max: number, windowMs: number) => Promise<boolean>;
  captcha?: (token: string, ip: string) => Promise<boolean>;   // Cloudflare Turnstile verifier; when set, registration and login require `turnstileToken`
  afterMail?: () => Promise<unknown>;                          // called after writes that queue email (sends them promptly)
  sendReviewMail?: (email: string, template: 'received' | 'approved' | 'rejected' | 'event_tomorrow' | 'thank_you') => Promise<void>;
  log?: (e: Record<string, unknown>) => void;                  // structured request/error logs (no query strings, no personal data)
  cronSecret?: string; runOutbox?: () => Promise<number>;      // enables GET /internal/outbox for cron retries
}
interface Ctx { params: Record<string, string>; query: URLSearchParams; body: any; user: User | null; token: string; headers: IncomingMessage['headers'] }
interface Out { status?: number; body?: unknown; cookie?: string }
interface Route { method: string; path: string; re: RegExp; keys: string[]; auth: boolean; limit?: [number, number]; captcha?: boolean; mail?: boolean; fn: (c: Ctx) => Promise<Out | void> }
const COOKIE = 'hh_session', MUT = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function createServer(svc: Service, opts: HttpOpts = {}) { return http.createServer(createHandler(svc, opts)); }

export function createHandler(svc: Service, opts: HttpOpts = {}) {
  const routes: Route[] = [];
  const add = (method: string, path: string, auth: boolean, fn: Route['fn'], limit?: [number, number], flags: { captcha?: boolean; mail?: boolean } = {}) => {
    const keys: string[] = [];
    const re = new RegExp('^/api/v1' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, path, re, keys, auth, limit, ...flags, fn });
  };
  const q = (c: Ctx) => Object.fromEntries(c.query) as Record<string, string>;
  const sess = (t: string, maxAge: number) => `${COOKIE}=${t}; HttpOnly; SameSite=${opts.sameSite ?? 'Lax'}; Path=/; Max-Age=${maxAge}${opts.secureCookies ? '; Secure' : ''}`;

  // public
  add('GET', '/events', false, async () => ({ body: { items: await svc.listPublicEvents() } }));
  add('GET', '/events/:id', false, async c => ({ body: await svc.getPublicEvent(c.params.id) }));
  add('POST', '/events/:id/registrations', false, async c => ({ status: 201, body: await svc.submitRegistration(c.params.id, c.body) }), [5, 3600_000], { captcha: true, mail: true });
  // auth
  add('POST', '/auth/login', false, async c => {
    const r = await svc.login(c.body?.email, c.body?.password);
    return { body: r.user, cookie: sess(r.token, 12 * 3600) };
  }, [10, 900_000], { captcha: true });
  add('POST', '/auth/logout', true, async c => { await svc.logout(c.token); return { body: { ok: true }, cookie: sess('', 0) }; });
  add('GET', '/auth/me', true, async c => ({ body: svc.me(c.user) }));
  // organiser / admin
  add('GET', '/admin/stats', true, async c => ({ body: await svc.stats(c.user) }));
  add('POST', '/admin/review-mail', true, async c => {
    if (c.user?.role !== 'admin') throw E.forbidden('Only admins can send review emails');
    const email = typeof c.body?.email === 'string' ? c.body.email.trim().toLowerCase() : '';
    const template = c.body?.template;
    const allowed = ['received', 'approved', 'rejected', 'event_tomorrow', 'thank_you'];
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) throw E.validation({ email: 'Enter a valid email address' });
    if (!allowed.includes(template)) throw E.validation({ template: 'Choose a valid email type' });
    if (!opts.sendReviewMail) throw new AppError('mail_unavailable', 503, 'Email sending is not configured');
    await opts.sendReviewMail(email, template);
    return { body: { ok: true, email, template } };
  }, [5, 3600_000]);
          add('POST', '/admin/events/:id/registrations', true, async c => ({ status: 201, body: await svc.manualRegister(c.user, c.params.id, c.body) }), undefined, { mail: true });
  add('GET', '/admin/applications', true, async c => ({ body: await svc.listApplications(c.user, q(c)) }));
  add('GET', '/admin/applications/:id', true, async c => ({ body: await svc.getApplication(c.user, c.params.id) }));
  add('POST', '/admin/applications/:id/decision', true, async c => ({ body: await svc.review(c.user, c.params.id, c.body?.decision, c.body?.reason) }), undefined, { mail: true });
  add('GET', '/admin/staff', true, async c => ({ body: { items: await svc.listStaff(c.user) } }));
  add('POST', '/admin/staff', true, async c => ({ status: 201, body: await svc.createStaff(c.user, c.body) }));
  add('PATCH', '/admin/staff/:id', true, async c => ({ body: await svc.updateStaff(c.user, c.params.id, c.body) }));
  add('GET', '/admin/audit-log', true, async c => ({ body: await svc.listAudit(c.user, q(c)) }));
  // cron / worker: retry queued emails. Disabled unless CRON_SECRET is configured.
  add('GET', '/internal/outbox', false, async c => {
    const want = createHash('sha256').update('Bearer ' + (opts.cronSecret ?? '\0')).digest(), got = createHash('sha256').update(String(c.headers.authorization ?? '')).digest();
    if (!opts.cronSecret || !opts.runOutbox || !timingSafeEqual(want, got)) throw E.notFound('Route not found');
    return { body: { sent: await opts.runOutbox() } };
  });
  // check-in
  add('GET', '/checkin/events', true, async c => ({ body: { items: await svc.checkinEvents(c.user) } }));
  add('GET', '/checkin/events/:id/stats', true, async c => ({ body: await svc.checkinStats(c.user, c.params.id) }));
  add('GET', '/checkin/events/:id/participants', true, async c => ({ body: { items: await svc.checkinSearch(c.user, c.params.id, c.query.get('q') ?? '') } }));
  add('POST', '/checkin/lookup', true, async c => ({ body: await svc.checkinLookup(c.user, c.body?.code) }), [60, 60_000]);
  add('POST', '/checkin/registrations/:id', true, async c => ({ body: await svc.checkIn(c.user, c.params.id) }), [60, 60_000]);

  const hits = new Map<string, { n: number; reset: number }>();
  let rateLimitOps = 0;
  const limited = async (key: string, [max, win]: [number, number]) => {
    if (opts.sharedRateLimit) return opts.sharedRateLimit(createHash('sha256').update(key).digest('hex'), max, win);
    const t = Date.now(), h = hits.get(key);
    if (!h || h.reset < t) hits.set(key, { n: 1, reset: t + win }); else h.n++;
    if (++rateLimitOps % 256 === 0) for (const [k, v] of hits) if (v.reset < t) hits.delete(k);
    return (hits.get(key)?.n ?? 0) > max;
  };
  const readJson = (req: IncomingMessage) => new Promise<any>((resolve, reject) => {
    let size = 0; const parts: Buffer[] = [];
    req.on('data', (d: Buffer) => { size += d.length; if (size > 100_000) { reject(new AppError('too_large', 413, 'Request body too large')); req.destroy(); } else parts.push(d); });
    req.on('end', () => { if (!parts.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch { reject(new AppError('bad_request', 400, 'Invalid JSON')); } });
    req.on('error', reject);
  });
  const send = (res: ServerResponse, status: number, body?: unknown, cookie?: string): void => {
    if (cookie) res.setHeader('set-cookie', cookie);
    if (body === undefined) { res.writeHead(status); res.end(); return; }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body));
  };

  const origins = (opts.corsOrigin ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const t0 = Date.now(), rid = randomUUID().slice(0, 8); let routeLabel = '';
    res.setHeader('x-request-id', rid);
    res.on('finish', () => opts.log?.({ t: new Date().toISOString(), rid, method: req.method, route: routeLabel || undefined, status: res.statusCode, ms: Date.now() - t0 }));
    res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('cache-control', 'no-store');
    res.setHeader('x-frame-options', 'DENY'); res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    if (opts.secureCookies) res.setHeader('strict-transport-security', 'max-age=63072000; includeSubDomains');
    const origin = req.headers.origin;
    if (origin && origins.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin); res.setHeader('access-control-allow-credentials', 'true'); res.setHeader('vary', 'origin');
      res.setHeader('access-control-allow-headers', 'content-type,x-hypehouse-csrf,x-turnstile-token'); res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') return send(res, 204);
    try {
      const url = new URL(req.url ?? '/', 'http://x'), method = req.method ?? 'GET';
      if (url.pathname === '/healthz' || url.pathname === '/api/healthz') return send(res, 200, { ok: true });
      let route: Route | undefined, params: Record<string, string> = {};
      for (const r of routes) {
        const m = r.method === method && r.re.exec(url.pathname);
        if (m) { route = r; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); break; }
      }
      if (!route) throw E.notFound('Route not found');
      routeLabel = route.method + ' ' + route.path;
      const ip = opts.trustProxy ? String(req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : req.socket.remoteAddress ?? '';
      // Apply the IP bucket before auth so unauthenticated attempts against
      // protected routes are covered too.
      const policy: [number, number] = route.limit ?? (MUT.has(method) ? [30, 60_000] : [120, 60_000]);
      if (await limited(ip + '|' + method + route.re.source, policy)) throw new AppError('rate_limited', 429, 'Too many requests, try again later');
      const token = /(?:^|;\s*)hh_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
      const user = token ? await svc.authenticate(token) : null;
      if (route.auth) {
        if (!user) throw E.unauth();
        if (MUT.has(method) && req.headers['x-hypehouse-csrf'] !== '1') throw E.forbidden('Missing CSRF header');
      }
      // Authenticated callers also get a per-account bucket, preventing many
      // IPs from bypassing the same user's request budget.
      if (user && await limited('user:' + user.id + '|' + method + route.re.source, policy)) {
        throw new AppError('rate_limited', 429, 'Too many requests, try again later');
      }
      const body = MUT.has(method) ? await readJson(req) : undefined;
      if (route.captcha && opts.captcha) {
        const t = body?.turnstileToken ?? req.headers['x-turnstile-token'];
        if (!t || !(await opts.captcha(String(t), ip))) throw new AppError('captcha', 400, 'Please complete the verification and try again');
        delete body.turnstileToken;
      }
      const out = (await route.fn({ params, query: url.searchParams, body, user, token, headers: req.headers })) ?? {};
      if (route.mail && opts.afterMail) await opts.afterMail().catch(() => {});
      send(res, out.status ?? 200, out.body, out.cookie);
    } catch (e) {
      if (e instanceof AppError) return send(res, e.status, { code: e.code, message: e.message, ...(e.fields ? { fields: e.fields } : {}), ...(e.extra ?? {}) });
      if (opts.log) opts.log({ level: 'error', rid, msg: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }); else console.error(e);
      send(res, 500, { code: 'internal', message: 'Something went wrong' });
    }
  };
}
