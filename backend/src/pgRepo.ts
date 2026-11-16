// UNTESTED against a real database: written offline. Run `npm i`, apply db/001_init.sql (npm run migrate) and test before relying on it.
import type { Repo, Registration, User, Session, OutboxRow, AuditRow } from './types.ts';
let rateLimitCleanup = 0;
const iso = (v: any) => (v == null ? null : new Date(v).toISOString());
const RG = `id,event_id AS "eventId",name,email,phone,dob::text AS dob,ec_name AS "ecName",ec_phone AS "ecPhone",answers,consent_terms AS "consentTerms",consent_marketing AS "consentMarketing",status,COALESCE(reason,'') AS reason,submitted_at AS "submittedAt",reviewed_by AS "reviewedBy",reviewed_at AS "reviewedAt",qr_token_hash AS "qrTokenHash",checked_in_at AS "checkedInAt",checked_in_by AS "checkedInBy"`;
const US = `u.id,u.email,u.name,u.password_hash AS "passwordHash",u.role,u.active`;
const rg = (r: any): Registration => ({ ...r, submittedAt: iso(r.submittedAt)!, reviewedAt: iso(r.reviewedAt), checkedInAt: iso(r.checkedInAt) });
const ob = (r: any): OutboxRow => ({ id: r.id, registrationId: r.registration_id, template: r.template, payload: r.payload, status: r.status, attempts: r.attempts, lastError: r.last_error, createdAt: iso(r.created_at)!, sentAt: iso(r.sent_at), scheduledAt: iso(r.scheduled_at) });

export async function createPgRepo(url: string, o: { ssl?: boolean; max?: number } = {}): Promise<Repo> {
  const { default: pg } = await import('pg');
  // Supabase requires TLS. Use the transaction pooler URL (port 6543) on serverless; keep the pool tiny.
  return new PgRepo(new pg.Pool({ connectionString: url, max: o.max ?? 3, ssl: o.ssl === false ? false : { rejectUnauthorized: false } }), null) as unknown as Repo;
}

class PgRepo {
  pool: any; client: any;
  constructor(pool: any, client: any) { this.pool = pool; this.client = client; }
  q(sql: string, p: unknown[] = []) { return (this.client ?? this.pool).query(sql, p); }
  async tx<T>(fn: (r: Repo) => Promise<T>): Promise<T> {
    if (this.client) return fn(this as unknown as Repo);
    const c = await this.pool.connect();
    try { await c.query('BEGIN'); const out = await fn(new PgRepo(this.pool, c) as unknown as Repo); await c.query('COMMIT'); return out; }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  async consumeRateLimit(key: string, max: number, windowMs: number) {
    const r = await this.q(`INSERT INTO api_rate_limits (bucket_key, window_started_at, hit_count) VALUES ($1, now(), 1)
      ON CONFLICT (bucket_key) DO UPDATE SET
        hit_count = CASE WHEN api_rate_limits.window_started_at <= now() - ($2 * interval '1 millisecond') THEN 1 ELSE api_rate_limits.hit_count + 1 END,
        window_started_at = CASE WHEN api_rate_limits.window_started_at <= now() - ($2 * interval '1 millisecond') THEN now() ELSE api_rate_limits.window_started_at END
      RETURNING hit_count`, [key, windowMs]);
    if (++rateLimitCleanup % 1000 === 0) await this.q(`DELETE FROM api_rate_limits WHERE window_started_at < now() - interval '1 day'`);
    return Number(r.rows[0].hit_count) > max;
  }
  async nextRegistrationId() { return (await this.q(`SELECT 'HH-'||nextval('reg_seq') AS id`)).rows[0].id as string; }
  async getRegistration(id: string, lock = false) { const r = await this.q(`SELECT ${RG} FROM registrations WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id]); return r.rows[0] ? rg(r.rows[0]) : null; }
  async listRegistrations(f?: { eventId?: string }) { const r = f?.eventId ? await this.q(`SELECT ${RG} FROM registrations WHERE event_id=$1`, [f.eventId]) : await this.q(`SELECT ${RG} FROM registrations`); return r.rows.map(rg); }
  async findRegistrationByPaymentId(paymentId: string) { const r = await this.q(`SELECT ${RG} FROM registrations WHERE upper(btrim(answers->>'paymentId'))=upper(btrim($1)) LIMIT 1`, [paymentId]); return r.rows[0] ? rg(r.rows[0]) : null; }
  async findRegistrationByQrHash(h: string) { const r = await this.q(`SELECT ${RG} FROM registrations WHERE qr_token_hash=$1`, [h]); return r.rows[0] ? rg(r.rows[0]) : null; }
  async saveRegistration(g: Registration) {
    await this.q(`INSERT INTO registrations (id,event_id,name,email,phone,dob,ec_name,ec_phone,answers,consent_terms,consent_marketing,status,reason,submitted_at,reviewed_by,reviewed_at,qr_token_hash,checked_in_at,checked_in_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT (id) DO UPDATE SET status=$12,reason=$13,reviewed_by=$15,reviewed_at=$16,qr_token_hash=$17,checked_in_at=$18,checked_in_by=$19`,
      [g.id, g.eventId, g.name, g.email, g.phone, g.dob, g.ecName, g.ecPhone, JSON.stringify(g.answers), g.consentTerms, g.consentMarketing, g.status, g.reason || null, g.submittedAt, g.reviewedBy, g.reviewedAt, g.qrTokenHash, g.checkedInAt, g.checkedInBy]);
  }
  async findUserByEmail(email: string) { const r = await this.q(`SELECT ${US} FROM users u WHERE lower(u.email)=lower($1)`, [email]); return (r.rows[0] as User) ?? null; }
  async getUser(id: string) { const r = await this.q(`SELECT ${US} FROM users u WHERE u.id=$1`, [id]); return (r.rows[0] as User) ?? null; }
  async listUsers() { return (await this.q(`SELECT ${US} FROM users u ORDER BY u.name`)).rows as User[]; }
  async saveUser(u: User) {
    await this.q(`INSERT INTO users (id,email,name,password_hash,role,active) VALUES ($1,lower($2),$3,$4,$5,$6)
      ON CONFLICT (id) DO UPDATE SET name=$3,password_hash=$4,role=$5,active=$6`, [u.id, u.email, u.name, u.passwordHash, u.role, u.active]);
  }
  async saveSession(s: Session) { await this.q(`INSERT INTO sessions (id,user_id,expires_at) VALUES ($1,$2,$3)`, [s.id, s.userId, s.expiresAt]); }
  async getSession(id: string) { const r = await this.q(`SELECT id,user_id AS "userId",expires_at AS "expiresAt" FROM sessions WHERE id=$1`, [id]); return r.rows[0] ? { ...r.rows[0], expiresAt: iso(r.rows[0].expiresAt)! } as Session : null; }
  async deleteSession(id: string) { await this.q(`DELETE FROM sessions WHERE id=$1`, [id]); }
  async deleteSessionsForUser(uid: string) { await this.q(`DELETE FROM sessions WHERE user_id=$1`, [uid]); }
  async addOutbox(o: OutboxRow) { await this.q(`INSERT INTO email_outbox (id,registration_id,template,payload,status,attempts,created_at,scheduled_at) VALUES ($1,$2,$3,$4,'queued',0,$5,$6)`, [o.id, o.registrationId, o.template, JSON.stringify(o.payload), o.createdAt, o.scheduledAt]); }
  async claimOutbox(limit: number) {
    const r = await this.q(`WITH due AS (SELECT id FROM email_outbox WHERE status='queued' AND attempts<5 AND (scheduled_at IS NULL OR scheduled_at<=now()) ORDER BY COALESCE(scheduled_at,created_at),created_at LIMIT $1 FOR UPDATE SKIP LOCKED) UPDATE email_outbox e SET attempts=e.attempts+1 FROM due WHERE e.id=due.id RETURNING e.*`, [limit]);
    return r.rows.map(ob);
  }
  async finishOutbox(id: string, ok: boolean, error?: string) {
    if (ok) await this.q(`UPDATE email_outbox SET status='sent',payload='{}',sent_at=now(),last_error=NULL WHERE id=$1`, [id]);
    else await this.q(`UPDATE email_outbox SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'queued' END,last_error=$2 WHERE id=$1`, [id, error ?? 'error']);
  }
  async listAudit(f: { action?: string; subjectType?: string; actorId?: string; from?: string; to?: string; limit: number; offset: number }) {
    const where: string[] = [], values: unknown[] = [];
    const add = (clause: string, value: unknown) => { values.push(value); where.push(clause.replace('?', String.fromCharCode(36) + values.length)); };
    if (f.action) add('a.action = ?', f.action);
    if (f.subjectType) add('a.subject_type = ?', f.subjectType);
    if (f.actorId) add('a.actor_id = ?::uuid', f.actorId);
    if (f.from) add('a.at >= ?::date', f.from);
    if (f.to) add("a.at < (?::date + interval '1 day')", f.to);
    values.push(f.limit + 1); const limitParam = String.fromCharCode(36) + values.length;
    values.push(f.offset); const offsetParam = String.fromCharCode(36) + values.length;
    const sql = `SELECT a.id,a.actor_id AS "actorId",u.name AS "actorName",u.email AS "actorEmail",
      a.action,a.subject_type AS "subjectType",a.subject_id AS "subjectId",a.meta,a.at
      FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY a.at DESC,a.id DESC LIMIT ${limitParam} OFFSET ${offsetParam}`;
    const r = await this.q(sql, values);
    return r.rows.map((row: any) => ({ ...row, at: iso(row.at)! })) as AuditRow[];
  }
  async addAudit(a: AuditRow) { await this.q(`INSERT INTO audit_log (id,actor_id,action,subject_type,subject_id,meta,at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [a.id, a.actorId, a.action, a.subjectType, a.subjectId, JSON.stringify(a.meta), a.at]); }
}
