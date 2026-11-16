# The Hype House API

A Hype House rebrand of the Vertex backend. It keeps application registration, organiser review, staff accounts, transactional email, QR ticketing, check-in and audit functionality. The editable Events admin section has been removed.

## Hardcoded event catalogue

The only source of event data is src/events.ts. The public event endpoints and registration/check-in workflows read from that file. There are no event create, edit or publish API endpoints and no events database table. Registration rows hold an event_id that must match an event ID in the static catalogue.

The current Pool Party has its date, venue, registration window and capacity marked as unannounced. Registration is disabled until those values are entered in src/events.ts. Keep an event's ID stable after registrations exist.

## Local development

Requires Node 22.13+.

1. Run npm install.
2. Copy .env.example to .env.
3. Run npm run typecheck, npm test and npm run build.
4. Run npm start.

Set SEED=1 only for local demo accounts. Do not seed production.

## Production

Create a dedicated Hype House Supabase project. Do not point this backend at Vertex's database and do not reuse Vertex credentials. Configure the new Vercel backend project with Root Directory backend. The existing Hype House website project remains rooted at the repository root. See PRODUCTION.md for required environment variables and migration instructions.
