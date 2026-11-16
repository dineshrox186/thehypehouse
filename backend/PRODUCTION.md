# Hype House backend deployment

The production API requires PostgreSQL and does not permit in-memory storage.

## Dedicated database

Create a separate Hype House Supabase project. Supabase is used only as managed PostgreSQL; this backend has its own staff sessions and does not use Supabase Auth or the Data API.

- DATABASE_URL: transaction-pooler connection string (normally port 6543), used at runtime.
- DATABASE_URL_DIRECT: direct Postgres connection string (normally port 5432), used for migrations.
- Apply migrations from this directory with npm install and npm run migrate.

The schema contains users, sessions, registrations, email_outbox, audit_log and api_rate_limits. It intentionally contains no events table: events are defined in src/events.ts. RLS is enabled and anon/authenticated access is revoked on backend-owned tables.

## Vercel

Create a separate Vercel project linked to this repository, with Root Directory set to backend and Framework set to Other. Do not change the root directory of the public website project.

Production environment variables:
- NODE_ENV=production
- REPO=pg
- DATABASE_URL and DATABASE_SSL=require
- CORS_ORIGIN set to the exact public Hype House website origin
- TRUST_PROXY=1 and SECURE_COOKIES=1
- TURNSTILE_SECRET
- RESEND_API_KEY and MAIL_FROM (verified sender)
- CRON_SECRET
- TICKET_URL
- EVENT_TIMEZONE=Asia/Kolkata (optional; this is the default)

Create the first admin by setting REPO=pg, DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD (12+ characters), and optionally ADMIN_NAME, then running npm run create-admin.

## API

Public: GET /api/v1/events, GET /api/v1/events/:id, POST /api/v1/events/:id/registrations.
Auth: POST /api/v1/auth/login, POST /api/v1/auth/logout, GET /api/v1/auth/me.
Admin: GET /api/v1/admin/stats, GET /api/v1/admin/applications, GET /api/v1/admin/applications/:id, POST /api/v1/admin/applications/:id/decision, GET/POST /api/v1/admin/staff, PATCH /api/v1/admin/staff/:id, GET /api/v1/admin/audit-log.
Manual registration: POST /api/v1/admin/events/:id/registrations.
Check-in: GET /api/v1/checkin/events, GET /api/v1/checkin/events/:id/stats, GET /api/v1/checkin/events/:id/participants, POST /api/v1/checkin/lookup, POST /api/v1/checkin/registrations/:id.
Internal: GET /api/v1/internal/outbox with Authorization: Bearer CRON_SECRET; GET /api/healthz.
There are no event create/edit/publish endpoints.

## Release checklist

Run npm run typecheck, npm test and npm run build. Verify login, role checks, Secure + HttpOnly cookie, X-HypeHouse-CSRF: 1 for authenticated writes, Turnstile failures, registration rate limiting, approval/rejection mail, QR lookup and duplicate check-in. Verify anonymous and authenticated Supabase API roles cannot read backend tables.

Supabase recommends RLS on exposed tables plus explicit revocation of existing Data API role grants for backend-only storage. The migration follows this model. See https://supabase.com/docs/guides/database/postgres/row-level-security.
