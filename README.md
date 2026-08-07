# IrisMono

B2B SaaS platform for medical/hospital customers that generates image masks from uploaded scans using GPU-bound ML models.

Multi-tenant: an **organization** owns a shared pool of credits, and people belong to it through **memberships** that carry their role. Processing is asynchronous — the browser uploads directly to object storage, a job is queued, a GPU worker consumes it, and the result is pushed back over Server-Sent Events.

| Document | What it is |
|---|---|
| `arch.md` | The original requirements brief |
| `architecture_specification.md` | The design that came out of it — schema, block diagram, credit logic |
| `AUDIT.md` | Full system audit: architecture critique, defects with evidence, and what has since been fixed |
| `frontend/README.md` | Frontend-specific notes |

---

## Prerequisites

- **Node.js 20+**
- **Docker** — provides PostgreSQL 15 and RabbitMQ 3

Ports used: **3000** (API), **3001** (frontend), **5432** (Postgres), **5672** / **15672** (RabbitMQ and its management UI).

---

## Setup

### 1. Infrastructure

```bash
cd backend
docker compose up -d
```

Wait for both containers to report healthy:

```bash
docker compose ps
```

### 2. Backend

```bash
cd backend
npm install
cp .env.example .env
npm run db:migrate
```

**Run the migrations before starting the API.** Migration `0002` is what creates the `irismono_app` and `irismono_auth` database roles that `.env` points at; the migration runner connects as the superuser via `ADMIN_DATABASE_URL` precisely because those roles do not exist yet. Starting the API first fails at the first query with an authentication error — see Troubleshooting.

Then, in two terminals:

```bash
npm run dev          # API on :3000
npm run worker:dev   # GPU worker (simulated), consumes queue-standard-jobs
```

### 3. Frontend

```bash
cd frontend
npm install
npm run dev          # http://localhost:3001
```

The frontend runs on 3001 because the API holds 3000. `/api/*` is rewritten to the backend (`next.config.ts`), which keeps everything same-origin — so the API needs no CORS configuration in development.

### 4. Try it

Open http://localhost:3001, choose **Create Workspace**, and register. The first account creates an organization, becomes its `ORG_ADMIN`, and receives 3 trial credits. Upload any image; the simulated worker takes ~5 seconds and succeeds about 90% of the time (the failure path is deliberate — it exercises the credit refund).

---

## Architecture

```
Browser ──1. reserve credit ──▶ API ──▶ Postgres (job + ledger entry)
        ──2. PUT image ───────▶ Object storage (mocked to ./uploads)
        ──3. trigger ─────────▶ API ──▶ RabbitMQ ──▶ GPU worker
                                                        │
                                          4. report outcome (shared secret)
                                                        ▼
        ◀── 6. SSE ─────────── API ◀── 5. fanout ── all API instances
```

A few decisions worth knowing before reading the code:

- **The worker holds no database credentials.** It reports outcomes to `POST /api/jobs/:id/report`; the API owns finalization, credit settlement, and notification. GPU workers are the least-trusted, most-scaled tier.
- **Credits are a ledger, not a counter.** `credit_transactions` is append-only, and a partial unique index on `(job_id, reason)` makes refunds idempotent at the database level. `organizations.credit_balance` is a materialized total, reconcilable at any time.
- **Tenant isolation is enforced by Row-Level Security**, not only by query predicates. The app connects as a non-superuser role and sets the org context per transaction — see "Database identities" below.
- **A session is scoped to one organization.** The JWT carries a single active `organizationId`; switching calls `POST /api/auth/switch-organization`, which re-checks the membership.
- **SSE survives multiple API instances.** Events append to `job_events`, then fan out over a RabbitMQ exchange. Clients resume with `Last-Event-ID`.

### Database identities

Three connection strings, deliberately separate. This is the part most likely to confuse on first read:

| Variable | Role | Purpose |
|---|---|---|
| `DATABASE_URL` | `irismono_app` | Everything tenant-scoped. RLS **enforced**. Must never be a superuser — superusers bypass RLS unconditionally. |
| `AUTH_DATABASE_URL` | `irismono_auth` | Operations with no tenant context yet: login, registration, invite redemption, worker reports. Has `BYPASSRLS`. |
| `ADMIN_DATABASE_URL` | `postgres` | DDL and migrations only. |

Tenant queries go through `withTenant(orgId, ...)` in `src/db/index.ts`, which opens a transaction and sets the org context locally to it. A session-level `SET` would leak across pooled connections.

---

## Tests

All suites need the infrastructure and the API running; most also need the worker.

```bash
cd backend
npm run test:flow        # end-to-end product flow
npm run test:rls         # tenant isolation, with query predicates deliberately omitted
npm run test:credits     # ledger integrity, refund idempotency, reconciliation
npm run test:lifecycle   # reaper, dead-lettering, tier routing, provenance
npm run test:identity    # one account across organizations, role per membership
npm run test:sse         # cross-instance delivery and Last-Event-ID replay
```

`test:sse` needs a **second API instance**, because a single-process test cannot distinguish a working bus from the in-process hub it replaced:

```bash
PORT=3002 npx tsx src/index.ts     # in another terminal
npm run test:sse
```

Type checking:

```bash
cd backend  && npx tsc --noEmit
cd frontend && npx tsc --noEmit
```

---

## Configuration

`backend/.env.example` documents every variable. The ones that matter most:

| Variable | Default | Notes |
|---|---|---|
| `JWT_SECRET` | hardcoded literal | **Change this.** The default is in the source tree, and a deployment missing the variable starts silently insecure. |
| `WORKER_SECRET` | `local-dev-worker-secret` | Authenticates the worker's job reports. Change alongside `JWT_SECRET`. |
| `MODEL_VERSION` | `irismono-seg-sim-0.1.0` | Stamped onto every completed job. In a real deployment this is the image tag or model digest, injected at deploy time. The API rejects a `SUCCESS` report without it. |
| `WORKER_QUEUES` | `queue-standard-jobs` | Start a second worker with `queue-vip-jobs` to give enterprise tenants dedicated capacity. |
| `JOB_PENDING_TIMEOUT_MINUTES` | `30` | After this, an undispatched reservation is expired and its credit returned. |
| `STORAGE_RETENTION_DAYS` | `30` | Deletes stored images. Job metadata is kept indefinitely for billing and audit. On real S3, use a bucket lifecycle rule instead — see `src/retention.ts`. |

Storage and the ML model are both mocked for local development. Images go to `./uploads`, and the worker sleeps instead of running a model. Point `AWS_S3_ENDPOINT` at MinIO or LocalStack for real presigned uploads.

---

## Troubleshooting

**`password authentication failed for user "irismono_app"`** — usually means the migrations have not run rather than a wrong password: Postgres reports a missing role as an authentication failure, so a role that was never created looks identical to a bad credential. `npm run db:migrate` creates the roles.

**Port 5432 already in use** — a local PostgreSQL install is holding it. Publish the container elsewhere with an override file (gitignored, so it stays machine-local):

```yaml
# backend/docker-compose.override.yml
services:
  postgres:
    ports: !override
      - "5433:5432"
```

Then point all three `*_DATABASE_URL` values in `.env` at 5433. `!override` replaces the base list rather than merging into it, so 5432 is not published at all and the target is unambiguous.

**Queries return zero rows for data you know exists** — the tenant context is missing. Anything reading tenant data must go through `withTenant()`; a bare `db.select()` on `irismono_app` correctly returns nothing.

**`PRECONDITION_FAILED` on startup after a queue change** — a queue exists with different arguments than the code now declares. Drain it, then delete it so it can be recreated:

```bash
docker exec irismono-rabbitmq rabbitmqctl delete_queue queue-standard-jobs
```

**Live job updates never arrive** — check that the browser obtained a stream token. `EventSource` cannot send an `Authorization` header, so the stream authenticates via a short-lived token in the query string, minted by `POST /api/auth/stream-token`.

---

## Stopping

```bash
cd backend
docker compose stop      # keeps the data volume; `down -v` destroys it
```
