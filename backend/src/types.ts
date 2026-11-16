export type Role = 'staff' | 'organiser' | 'admin';
export type Status = 'pending' | 'approved' | 'rejected';
export interface CustomField { k: string; l: string; req?: boolean }
export interface EventRow {
  id: string; name: string; description: string; startsAt: string | null; venue: string; address: string; mapUrl: string;
  capacity: number; coverImage: string | null; published: boolean; registrationEnabled: boolean; regOpensAt: string | null; regClosesAt: string | null;
  terms: string; fields: CustomField[];
}
export interface Registration {
  id: string; eventId: string; name: string; email: string; phone: string; dob: string | null; ecName: string | null; ecPhone: string | null;
  answers: Record<string, string>; consentTerms: boolean; consentMarketing: boolean;
  status: Status; reason: string; submittedAt: string; reviewedBy: string | null; reviewedAt: string | null;
  qrTokenHash: string | null; checkedInAt: string | null; checkedInBy: string | null;
}
export interface User { id: string; email: string; name: string; passwordHash: string; role: Role; active: boolean }
export interface Session { id: string; userId: string; expiresAt: string }
export interface OutboxRow {
  id: string; registrationId: string; template: 'received' | 'approved' | 'rejected' | 'event_tomorrow' | 'thank_you'; payload: Record<string, unknown>;
  status: 'queued' | 'sent' | 'failed'; attempts: number; lastError: string | null; createdAt: string; sentAt: string | null; scheduledAt: string | null;
}
export interface AuditRow { id: string; actorId: string | null; actorName?: string | null; actorEmail?: string | null; action: string; subjectType: string; subjectId: string; meta: Record<string, unknown>; at: string }

export interface Repo {
  tx<T>(fn: (r: Repo) => Promise<T>): Promise<T>;
  consumeRateLimit(key: string, max: number, windowMs: number): Promise<boolean>;
  lockEvent(eventId: string): Promise<void>;
  nextRegistrationId(): Promise<string>;
  getRegistration(id: string, lock?: boolean): Promise<Registration | null>;
  listRegistrations(f?: { eventId?: string }): Promise<Registration[]>;
  findRegistrationByPaymentId(paymentId: string): Promise<Registration | null>;
  findRegistrationByQrHash(hash: string): Promise<Registration | null>;
  saveRegistration(r: Registration): Promise<void>;
  findUserByEmail(email: string): Promise<User | null>;
  getUser(id: string): Promise<User | null>;
  listUsers(): Promise<User[]>;
  saveUser(u: User): Promise<void>;
  saveSession(s: Session): Promise<void>;
  getSession(id: string): Promise<Session | null>;
  deleteSession(id: string): Promise<void>;
  deleteSessionsForUser(userId: string): Promise<void>;
  addOutbox(o: OutboxRow): Promise<void>;
  claimOutbox(limit: number): Promise<OutboxRow[]>;
  finishOutbox(id: string, ok: boolean, error?: string): Promise<void>;
  listAudit(f: { action?: string; subjectType?: string; actorId?: string; from?: string; to?: string; limit: number; offset: number }): Promise<AuditRow[]>;
  addAudit(a: AuditRow): Promise<void>;
}
