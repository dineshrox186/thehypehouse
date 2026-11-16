import { randomBytes, randomUUID } from 'node:crypto';
import type { Repo, User, Role, EventRow, Registration, OutboxRow, CustomField } from './types.ts';
import { AppError, E } from './errors.ts';
import { EVENTS, getEvent } from './events.ts';
import { sha, hashPassword, verifyPassword, DUMMY_HASH } from './auth.ts';

const ORG: Role[] = ['organiser', 'admin'];
const ALL: Role[] = ['staff', 'organiser', 'admin'];
const SESSION_MS = 12 * 3600 * 1000;
const APPLICATION_FIELDS: CustomField[] = [
  { k: 'institution', l: 'Institution', req: true },
  { k: 'grade', l: 'Grade', req: true },
  { k: 'paymentId', l: 'Payment ID / UTR', req: true },
  { k: 'instagramUsername', l: 'Instagram username', req: true },
];
const applicationFields = (fields: CustomField[] = []) => [
  ...APPLICATION_FIELDS.map(x => ({ ...x })),
  ...fields.filter(x => !APPLICATION_FIELDS.some(base => base.k === x.k)),
];
const mask = (p: string) => p.replace(/\d(?=(?:\D*\d){3})/g, '•');
const need = (u: User | null, roles: Role[]): User => { if (!u) throw E.unauth(); if (!roles.includes(u.role)) throw E.forbidden(); return u; };
const pubUser = (u: User) => ({ id: u.id, email: u.email, name: u.name, role: u.role, active: u.active });
const admView = (r: Registration) => ({ id: r.id, eventId: r.eventId, name: r.name, email: r.email, phone: r.phone, dob: r.dob, ecName: r.ecName,
  ecPhone: r.ecPhone, answers: r.answers, submittedAt: r.submittedAt, status: r.status, reason: r.reason, checkedInAt: r.checkedInAt });
const part = (r: Registration) => ({ id: r.id, eventId: r.eventId, name: r.name, phoneMasked: mask(r.phone), status: r.status, checkedInAt: r.checkedInAt });

const validDateOnly = (s: string, today = new Date()) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); if (!m) return false; const y=Number(m[1]), mo=Number(m[2]), d=Number(m[3]); const dt=new Date(Date.UTC(y,mo-1,d)); return y>=1900 && dt.getUTCFullYear()===y && dt.getUTCMonth()===mo-1 && dt.getUTCDate()===d && dt.getTime()<=today.getTime(); };

export function createService(repo: Repo, opts: { now?: () => Date } = {}) {
  const now = opts.now ?? (() => new Date());
  const iso = () => now().toISOString();
  const outbox = (registrationId: string, template: OutboxRow['template'], payload: Record<string, unknown>, scheduledAt: string | null = null): OutboxRow =>
    ({ id: randomUUID(), registrationId, template, payload, status: 'queued', attempts: 0, lastError: null, createdAt: iso(), sentAt: null, scheduledAt });
  const queueApprovedEmails = async (r: Repo, ev: EventRow, reg: Registration, token: string) => {
    await r.addOutbox(outbox(reg.id, 'approved', { token }));
    if (!ev.startsAt) return;
    const nowMs = now().getTime(), startMs = new Date(ev.startsAt).getTime(), day = 24 * 60 * 60 * 1000;
    if (startMs > nowMs) await r.addOutbox(outbox(reg.id, 'event_tomorrow', { token }, new Date(Math.max(nowMs, startMs - day)).toISOString()));
    if (startMs + day > nowMs) await r.addOutbox(outbox(reg.id, 'thank_you', { token }, new Date(Math.max(nowMs, startMs + day)).toISOString()));
  };
  const audit = (r: Repo, actor: User | null, action: string, subjectType: string, subjectId: string, meta: Record<string, unknown> = {}) =>
    r.addAudit({ id: randomUUID(), actorId: actor?.id ?? null, action, subjectType, subjectId, meta, at: iso() });
  const withCounts = async (r: Repo, evs: EventRow[]) => {
    const regs = await r.listRegistrations();
    return evs.map(e => ({ ...e, registered: regs.filter(x => x.eventId === e.id && x.status === 'approved').length }));
  };
  const approvedCount = async (r: Repo, eventId: string) => (await r.listRegistrations({ eventId })).filter(x => x.status === 'approved').length;
  const ciStats = async (r: Repo, eventId: string) => {
    const a = (await r.listRegistrations({ eventId })).filter(x => x.status === 'approved'), c = a.filter(x => x.checkedInAt).length;
    return { registered: a.length, checkedIn: c, remaining: a.length - c };
  };

  function validateReg(ev: EventRow, b: any, requireTerms: boolean, manual = false) {
    const f: Record<string, string> = {};
    const s = (k: string) => (typeof b?.[k] === 'string' ? b[k].trim() : '');
    for (const k of (manual ? ['name', 'email', 'phone'] : ['name', 'dob', 'email', 'phone', 'ecName', 'ecPhone'])) { if (!s(k)) f[k] = 'Required'; else if (s(k).length > 200) f[k] = 'Too long'; }
    if (manual) for (const k of ['dob', 'ecName', 'ecPhone']) if (s(k).length > 200) f[k] = 'Too long';
    if (s('email') && !/^\S+@\S+\.\S+$/.test(s('email'))) f.email = 'Enter a valid email';
    for (const k of ['phone', 'ecPhone']) if (s(k) && s(k).replace(/\D/g, '').length < 7) f[k] = 'Enter a valid phone number';
    if (s('dob') && !validDateOnly(s('dob'), now())) f.dob = 'Enter a real date of birth in YYYY-MM-DD format';
    if (requireTerms && b?.terms !== true) f.terms = 'You must accept the terms';
    if (requireTerms && b?.mail !== true) f.mail = 'You must accept emails';
    const answers: Record<string, string> = {};
    for (const cf of applicationFields(ev.fields)) {
      const v = typeof b?.answers?.[cf.k] === 'string' ? b.answers[cf.k].trim() : '';
      if (!manual && cf.req !== false && !v) f['answers.' + cf.k] = 'Required'; else if (v) answers[cf.k] = v.slice(0, 500);
    }
    if (Object.keys(f).length) throw E.validation(f);
    return { name: s('name'), dob: s('dob') || null, email: s('email').toLowerCase(), phone: s('phone'), ecName: s('ecName') || null, ecPhone: s('ecPhone') || null,
      answers, consentMarketing: b?.mail === true };
  }
  const newReg = async (r: Repo, ev: EventRow, d: ReturnType<typeof validateReg>, status: 'pending' | 'approved', terms: boolean, by: string | null): Promise<Registration> =>
    ({ id: await r.nextRegistrationId(), eventId: ev.id, ...d, consentTerms: terms, status, reason: '', submittedAt: iso(),
      reviewedBy: by, reviewedAt: by ? iso() : null, qrTokenHash: null, checkedInAt: null, checkedInBy: null });
  const checkRoom = async (r: Repo, ev: EventRow, paymentId: string) => {
    if (paymentId && await r.findRegistrationByPaymentId(paymentId)) throw E.conflict('payment_id_used', 'This payment ID has already been used');
    const regs = await r.listRegistrations({ eventId: ev.id });
    if (regs.filter(x => x.status === 'approved').length >= ev.capacity) throw E.conflict('full', 'This event is full');
  };
  const withPaymentIdConflict = async <T>(run: () => Promise<T>): Promise<T> => {
    try { return await run(); }
    catch (error) {
      const pgError = error as { code?: string; constraint?: string };
      if (pgError?.code === '23505' && pgError.constraint === 'registrations_payment_id_unique') {
        throw E.conflict('payment_id_used', 'This payment ID has already been used');
      }
      throw error;
    }
  };


  return {
    /* ---------- auth ---------- */
    async login(email: string, password: string) {
      const u = await repo.findUserByEmail(String(email ?? '').trim().toLowerCase());
      const ok = await verifyPassword(String(password ?? ''), u?.passwordHash ?? DUMMY_HASH);
      if (!u || !u.active || !ok) throw E.unauth('Invalid email or password');
      const token = randomBytes(32).toString('base64url');
      await repo.saveSession({ id: sha(token), userId: u.id, expiresAt: new Date(now().getTime() + SESSION_MS).toISOString() });
      return { token, user: pubUser(u) };
    },
    async logout(token: string) { await repo.deleteSession(sha(token)); },
    async authenticate(token: string): Promise<User | null> {
      const s = await repo.getSession(sha(token));
      if (!s) return null;
      if (+new Date(s.expiresAt) < now().getTime()) { await repo.deleteSession(s.id); return null; }
      const u = await repo.getUser(s.userId);
      return u && u.active ? u : null;
    },
    me: (actor: User | null) => pubUser(need(actor, ALL)),

    /* ---------- public ---------- */
    async listPublicEvents() { return withCounts(repo, EVENTS.filter(e => e.published).sort((a, b) => (a.startsAt ? +new Date(a.startsAt) : Number.MAX_SAFE_INTEGER) - (b.startsAt ? +new Date(b.startsAt) : Number.MAX_SAFE_INTEGER))); },
    async getPublicEvent(id: string) {
      const e = getEvent(id); if (!e || !e.published) throw E.notFound('Event not found');
      return (await withCounts(repo, [{ ...e, fields: applicationFields(e.fields) }]))[0];
    },
    async submitRegistration(eventId: string, body: any) {
      return withPaymentIdConflict(() => repo.tx(async r => {
        const ev = getEvent(eventId);
        if (!ev || !ev.published) throw E.notFound('Event not found');
        if (!ev.registrationEnabled || !ev.regOpensAt || !ev.regClosesAt) throw E.closed();
        await r.lockEvent(ev.id);
        const t = now().getTime();
        if (t < +new Date(ev.regOpensAt) || t > +new Date(ev.regClosesAt)) throw E.closed();
        const d = validateReg(ev, body, true);
        await checkRoom(r, ev, d.answers.paymentId);
        const reg = await newReg(r, ev, d, 'pending', true, null);
        await r.saveRegistration(reg); await r.addOutbox(outbox(reg.id, 'received', {}));
        return { id: reg.id, status: reg.status };
      }));
    },

    /* ---------- organiser ---------- */
    async stats(actor: User | null) {
      need(actor, ORG);
      const regs = await repo.listRegistrations(), evs = EVENTS, n = (s: string) => regs.filter(x => x.status === s).length;
      const approved = n('approved'), checkedIn = regs.filter(x => x.status === 'approved' && x.checkedInAt).length;
      return { events: evs.length, upcoming: evs.filter(e => e.startsAt !== null && +new Date(e.startsAt) > now().getTime()).length, registrations: regs.length,
        pending: n('pending'), approved, rejected: n('rejected'), checkedIn, attendance: approved ? Math.round(checkedIn / approved * 100) : 0 };
    },
    async listApplications(actor: User | null, q: { eventId?: string; status?: string; q?: string; sort?: string; limit?: number; cursor?: string } = {}) {
      need(actor, ORG);
      let l = await repo.listRegistrations(q.eventId ? { eventId: q.eventId } : undefined);
      if (q.status) l = l.filter(x => x.status === q.status);
      const s = (q.q ?? '').trim().toLowerCase();
      if (s) l = l.filter(x => (x.name + ' ' + x.email + ' ' + x.id).toLowerCase().includes(s));
      const t = (x: Registration) => +new Date(x.submittedAt);
      l.sort(q.sort === 'name' ? (a, b) => a.name.localeCompare(b.name) : q.sort === 'old' ? (a, b) => t(a) - t(b) : (a, b) => t(b) - t(a));
      const limit = Math.min(Math.max(Number(q.limit) || 25, 1), 100), off = Math.max(parseInt(q.cursor ?? '0', 10) || 0, 0);
      return { items: l.slice(off, off + limit).map(admView), nextCursor: off + limit < l.length ? String(off + limit) : null };
    },
    async getApplication(actor: User | null, id: string) {
      need(actor, ORG); const r = await repo.getRegistration(id); if (!r) throw E.notFound('Application not found'); return admView(r);
    },
    async review(actor: User | null, id: string, decision: unknown, reason?: string) {
      const u = need(actor, ORG);
      if (decision !== 'approved' && decision !== 'rejected') throw E.validation({ decision: 'Must be approved or rejected' });
      const why = String(reason ?? '').trim();
      if (decision === 'rejected' && !why) throw E.validation({ reason: 'A reason is required' });
      return repo.tx(async r => {
        const reg = await r.getRegistration(id, true); if (!reg) throw E.notFound('Application not found');
        if (reg.status !== 'pending') throw E.conflict('state', 'Only pending applications can be reviewed');
        let token = '', approvedEvent: EventRow | null = null;
        if (decision === 'approved') {
          approvedEvent = getEvent(reg.eventId);
          if (!approvedEvent) throw E.conflict('event_unavailable', 'The hardcoded event configuration is unavailable');
          await r.lockEvent(approvedEvent.id);
          if ((await approvedCount(r, approvedEvent.id)) >= approvedEvent.capacity) throw E.conflict('full', 'No places remain for this event');
          token = randomBytes(16).toString('base64url'); reg.qrTokenHash = sha(token);
        }
        reg.status = decision; reg.reason = decision === 'rejected' ? why : ''; reg.reviewedBy = u.id; reg.reviewedAt = iso();
        await r.saveRegistration(reg);
        if (decision === 'approved' && approvedEvent) await queueApprovedEmails(r, approvedEvent, reg, token);
        else await r.addOutbox(outbox(reg.id, 'rejected', { reason: why }));
        await audit(r, u, 'application.' + decision, 'registration', reg.id);
        return admView(reg);
      });
    },
    async manualRegister(actor: User | null, eventId: string, body: any) {
      const u = need(actor, ORG);
      return withPaymentIdConflict(() => repo.tx(async r => {
        const ev = getEvent(eventId); if (!ev) throw E.notFound('Event not found');
        if (!ev.registrationEnabled || ev.capacity < 1) throw E.closed();
        await r.lockEvent(ev.id);
        const d = validateReg(ev, body, false, true); await checkRoom(r, ev, d.answers.paymentId ?? '');
        const reg = await newReg(r, ev, d, 'approved', false, u.id), token = randomBytes(16).toString('base64url');
        reg.qrTokenHash = sha(token); await r.saveRegistration(reg);
        await queueApprovedEmails(r, ev, reg, token); await audit(r, u, 'registration.manual', 'registration', reg.id);
        return admView(reg);
      }));
    },

    /* ---------- staff management ---------- */
    async listStaff(actor: User | null) {
      const u = need(actor, ORG); return (await repo.listUsers()).filter(x => u.role === 'admin' || x.role === 'staff').map(pubUser);
    },
    async createStaff(actor: User | null, b: any) {
      const u = need(actor, ORG), f: Record<string, string> = {};
      const email = String(b?.email ?? '').trim().toLowerCase(), name = String(b?.name ?? '').trim(), role: Role = b?.role ?? 'staff';
      if (!/^\S+@\S+\.\S+$/.test(email)) f.email = 'Enter a valid email';
      if (!name) f.name = 'Required';
      if (typeof b?.password !== 'string' || b.password.length < 10) f.password = 'At least 10 characters';
      if (!ALL.includes(role)) f.role = 'Invalid';
      if (Object.keys(f).length) throw E.validation(f);
      if (role !== 'staff' && u.role !== 'admin') throw E.forbidden('Only an admin can create organisers or admins');
      return repo.tx(async r => {
        if (await r.findUserByEmail(email)) throw E.conflict('duplicate', 'A user with this email already exists');
        const nu: User = { id: randomUUID(), email, name, passwordHash: await hashPassword(b.password), role, active: true };
        await r.saveUser(nu); await audit(r, u, 'staff.create', 'user', nu.id, { role }); return pubUser(nu);
      });
    },
    async updateStaff(actor: User | null, id: string, b: any) {
      const u = need(actor, ORG);
      return repo.tx(async r => {
        const t = await r.getUser(id); if (!t) throw E.notFound('User not found');
        if (t.role !== 'staff' && u.role !== 'admin') throw E.forbidden();
        if (b?.name !== undefined) t.name = String(b.name).trim() || t.name;
        if (b?.password !== undefined) { if (typeof b.password !== 'string' || b.password.length < 10) throw E.validation({ password: 'At least 10 characters' }); t.passwordHash = await hashPassword(b.password); }
        if (b?.active !== undefined) { if (typeof b.active !== 'boolean') throw E.validation({ active: 'Invalid' }); t.active = b.active; }
        await r.saveUser(t);
        if (!t.active || b?.password !== undefined) await r.deleteSessionsForUser(t.id);
        await audit(r, u, 'staff.update', 'user', id); return pubUser(t);
      });
    },

    async listAudit(actor: User | null, q: { action?: string; subjectType?: string; actorId?: string; from?: string; to?: string; limit?: number; cursor?: string } = {}) {
      need(actor, ['admin']);
      const validDate = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
      if (q.from && !validDate(q.from)) throw E.validation({ from: 'Use YYYY-MM-DD' });
      if (q.to && !validDate(q.to)) throw E.validation({ to: 'Use YYYY-MM-DD' });
      if (q.from && q.to && q.from > q.to) throw E.validation({ to: 'Must be on or after the start date' });
      const action = String(q.action ?? '').trim(), subjectType = String(q.subjectType ?? '').trim(), actorId = String(q.actorId ?? '').trim();
      if (action.length > 80 || subjectType.length > 40 || actorId.length > 80) throw E.validation({ filters: 'Filter is too long' });
      if (actorId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actorId)) throw E.validation({ actorId: 'Enter a valid user UUID' });
      const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 100), offset = Math.max(parseInt(q.cursor ?? '0', 10) || 0, 0);
      if (offset > 100000) throw E.validation({ cursor: 'Invalid cursor' });
      const rows = await repo.listAudit({ action: action || undefined, subjectType: subjectType || undefined, actorId: actorId || undefined, from: q.from, to: q.to, limit, offset });
      const hasMore = rows.length > limit;
      return { items: rows.slice(0, limit), nextCursor: hasMore ? String(offset + limit) : null };
    },

    /* ---------- check-in ---------- */
    async checkinEvents(actor: User | null) {
      need(actor, ALL); return withCounts(repo, EVENTS.filter(e => e.published));
    },
    async checkinStats(actor: User | null, eventId: string) {
      need(actor, ALL); if (!getEvent(eventId)) throw E.notFound('Event not found');
      return ciStats(repo, eventId);
    },
    async checkinSearch(actor: User | null, eventId: string, q: string) {
      need(actor, ALL);
      const s = String(q ?? '').trim().toLowerCase(), dq = s.replace(/\D/g, ''); if (!s) return [];
      return (await repo.listRegistrations({ eventId })).filter(x => x.name.toLowerCase().includes(s) || x.id.toLowerCase() === s ||
        (dq.length > 2 && x.phone.replace(/\D/g, '').includes(dq))).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 20).map(part);
    },
    async checkinLookup(actor: User | null, code: unknown) {
      need(actor, ALL);
      const value = typeof code === 'string' ? code.trim() : '';
      const reg = value ? (/^HH-\d+$/i.test(value) ? await repo.getRegistration(value.toUpperCase()) : await repo.findRegistrationByQrHash(sha(value))) : null;
      if (!reg) throw E.notFound('Code not recognised');
      return part(reg);
    },
    async checkIn(actor: User | null, id: string) {
      const u = need(actor, ALL);
      return repo.tx(async r => {
        const reg = await r.getRegistration(id, true);
        if (!reg) throw E.notFound('Registration not found');
        if (reg.status !== 'approved') throw E.conflict('state', 'Not an approved registration');
        if (reg.checkedInAt) throw E.conflict('duplicate', 'Already checked in', { checkedInAt: reg.checkedInAt });
        reg.checkedInAt = iso(); reg.checkedInBy = u.id; await r.saveRegistration(reg);
        await audit(r, u, 'checkin', 'registration', reg.id);
        return { participant: part(reg), stats: await ciStats(r, reg.eventId) };
      });
    },
  };
}
export type Service = ReturnType<typeof createService>;
export { AppError };
