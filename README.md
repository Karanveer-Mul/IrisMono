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

Ports used: **3000** (API), **3001** (frontend), **5432** (Postgres), **5672** / **15672** (RabbitMQ and its management UI), **9101** (worker probes and metrics).

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

Open http://localhost:3001, choose **Create Workspace**, and register. The first account creates an organization, becomes its `ORG_ADMIN`, and receives 3 trial credits. Upload a PNG — the storage layer rejects anything else — and the upload itself queues the job. The simulated worker takes ~5 seconds and succeeds about 90% of the time (the failure path is deliberate — it exercises the credit refund).

---

## Architecture

```
Browser ──1. reserve credit ──▶ API ──▶ Postgres (job + ledger entry)
        ──2. PUT image ───────▶ Object storage (mocked to ./uploads)
                                        │
                          3. upload completed ──▶ API ──▶ RabbitMQ ──▶ GPU worker
                                                                          │
                                                    4. report outcome (shared secret)
                                                                          ▼
        ◀── 6. SSE ────────────────────── API ◀── 5. fanout ── all API instances
```

The browser makes two calls, not three. **Completing the upload is what queues the job** — on real S3 that is the bucket's event notification calling `POST /api/jobs/storage-events`; locally the mock storage layer is the API itself, so it dispatches directly. A closed tab can no longer strand a reserved credit, and a job can never be queued for an image that was never uploaded.

A few decisions worth knowing before reading the code:

- **The worker holds no database credentials.** It reports outcomes to `POST /api/jobs/:id/report`; the API owns finalization, credit settlement, and notification. GPU workers are the least-trusted, most-scaled tier.
- **Credits are a ledger, not a counter.** `credit_transactions` is append-only, and a partial unique index on `(job_id, reason)` makes refunds idempotent at the database level. `organizations.credit_balance` is a materialized total, reconcilable at any time.
- **Tenant isolation is enforced by Row-Level Security**, not only by query predicates. The app connects as a non-superuser role and sets the org context per transaction — see "Database identities" below.
- **A session is scoped to one organization.** The JWT carries a single active `organizationId`; switching calls `POST /api/auth/switch-organization`, which re-checks the membership.
- **SSE survives multiple API instances.** Events append to `job_events`, then fan out over a RabbitMQ exchange. Clients resume with `Last-Event-ID`.
- **Liveness and readiness are different questions.** Only readiness consults Postgres and RabbitMQ — see "Operations" below.
- **A failed job is retried before it is abandoned.** Delay queues hold it for `10s`, `60s`, then `300s`; expiry in the delay queue *is* the redelivery. Only after those does it dead-letter.
- **Dispatch is single-shot.** `dispatched_at` is claimed by one caller, so a double-clicked trigger cannot queue the same scan twice.
- **Uploads are validated at the storage layer.** Size ceiling enforced as bytes stream in (not from `Content-Length`, which the client picks), and the PNG signature is checked. A rejected upload fails the job and returns the credit immediately rather than waiting for the reaper.

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
npm run test:observability  # probes, metrics, fleet visibility, correlation ids
npm run test:security    # audit chain, invite caps, encryption at rest, lockout
npm run test:retention   # deletes refused as superuser, workspace closure, deactivation
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
| `STORAGE_EVENT_SECRET` | `local-dev-storage-secret` | Authenticates `POST /api/jobs/storage-events`. Separate from `WORKER_SECRET` on purpose — the notifier can start work, the worker can settle it. |
| `MAX_UPLOAD_BYTES` | `26214400` | Ceiling on a single scan, enforced while streaming. |
| `JOB_RETRY_DELAYS_MS` | `10000,60000,300000` | Redelivery schedule for a job whose outcome could not be established. One holding queue is declared per entry, so changing this adds or removes queues rather than altering existing ones. Exhausting the list dead-letters the message. |
| `JOB_PENDING_TIMEOUT_MINUTES` | `30` | After this, an undispatched reservation is expired and its credit returned. |
| `MASTER_KEY_BASE64` | empty | Wraps each organization's data key; 32 bytes, base64. Unset means scans are stored in the clear — see Security. |
| `MAX_FAILED_LOGINS` | `5` | Consecutive failures before a 15-minute lockout. |
| `DEFAULT_INVITE_MAX_USES` | `25` | Applied when an admin creates a link without a cap. |
| `METRICS_TOKEN` | empty | Bearer token for `/metrics` and `/health/workers`. Unset leaves them open; see Operations. |
| `WORKER_HEALTH_PORT` | `9101` | Where a worker answers probes and scrapes. Give each worker on a shared host its own port; `0` disables the listener. |
| `WORKER_STALE_AFTER_SECONDS` | `45` | When the API stops counting a worker as online. Set independently of the worker's own heartbeat interval, because the API cannot know how a given worker was configured. |
| `SHUTDOWN_DRAIN_MS` | `0` | How long to keep serving after SIGTERM. Zero suits local development; see Operations for what a deployment needs. |
| `STORAGE_RETENTION_DAYS` | `30` | Deletes stored images. Job metadata is kept indefinitely for billing and audit. On real S3, use a bucket lifecycle rule instead — see `src/retention.ts`. |

**Wiring a real bucket.** Point `AWS_S3_ENDPOINT` at S3, MinIO, or LocalStack, then configure the bucket to notify the API on upload — that notification is what queues the job:

```bash
aws s3api put-bucket-notification-configuration \
  --bucket <bucket> \
  --notification-configuration '{
    "TopicConfigurations": [{
      "TopicArn": "<sns-topic-that-posts-to-/api/jobs/storage-events>",
      "Events": ["s3:ObjectCreated:*"],
      "Filter": {"Key": {"FilterRules": [{"Name": "suffix", "Value": "raw.png"}]}}
    }]
  }'
```

The endpoint requires `STORAGE_EVENT_SECRET` in an `x-storage-secret` header. Note that the size ceiling cannot be enforced on a presigned PUT — a presigned POST policy with `content-length-range` is what a production deployment needs there.

Storage and the ML model are both mocked for local development. Images go to `./uploads`, and the worker sleeps instead of running a model. Point `AWS_S3_ENDPOINT` at MinIO or LocalStack for real presigned uploads.

---

## Security

- **Scans are encrypted at rest, per tenant.** Each organization has its own AES-256-GCM data key, stored only wrapped by `MASTER_KEY_BASE64`. Destroying one tenant's key makes that tenant's scans unreadable without touching anyone else's — which is how "delete our data" is honoured across object storage and backups. Leave `MASTER_KEY_BASE64` unset and scans are stored in the clear; it is deliberately not defaulted, because a hardcoded fallback would encrypt everything with a key published in this repository.
- **The audit log is append-only and tamper-evident.** `audit_events` is hash-chained. `UPDATE`/`DELETE` are revoked from the application roles, a trigger blocks them for the owner too, and `GET /api/audit/verify` recomputes the chain and names the first row that does not verify. Sign-ins, invite activity (including every refusal and its reason), whitelist changes, and **every read of a scan** are recorded.
- **Invite links expire and run out.** Default 25 uses and 30 days when unspecified, enforced by a `CHECK` constraint as well as by the handler, and `memberships.invite_id` records which link admitted whom.
- **Sign-ins are throttled.** Five failures lock an account for 15 minutes, counted in the database so the limit does not divide by the number of API instances. Passwords are length-first: 12 characters minimum.
- **The record cannot be deleted out from under itself.** Jobs, ledger entries, and the invites that admitted people reference their parents with `ON DELETE RESTRICT`, so deleting an organization or a user is refused rather than cascaded — including for a superuser at a `psql` prompt. Removing a customer is closure (`DELETE /api/auth/organization`, ORG_ADMIN), which stops the tenant acting and keeps everything else. Closure is not erasure: a tenant asking for their data to be destroyed is served by destroying their data key, which leaves the billing and audit metadata that must be retained. There is deliberately no button for closure in the dashboard — it is an API call, and an irreversible-looking one next to the upload form invites the accident it is hard to undo.

Generate a master key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**Not implemented**, and load-bearing for a real deployment: a KMS (the master key is an environment variable, so it shares a blast radius with the process that reads it), SSO/SAML, MFA, and DICOM de-identification. `AUDIT.md` §7 explains what each would take and why a half-version of it would be worse than its absence.

---

## Operations

| Endpoint | Port | What it answers |
|---|---|---|
| `GET /health` | 3000 | Liveness. Never touches a dependency — a failing liveness probe gets the container killed, and killing every instance because Postgres blinked removes the capacity that would have absorbed it. |
| `GET /health/ready` | 3000 | Readiness. Probes `postgres_app`, `postgres_auth`, and `rabbitmq`; 503 if any is down, which withdraws the instance without restarting it. |
| `GET /health/workers` | 3000 | The GPU fleet, as reported by heartbeats. Never fails the request — it describes something other than the process answering it. |
| `GET /metrics` | 3000 | Prometheus scrape. |
| `GET /health`, `/health/ready`, `/metrics` | 9101 | The worker's own probes. Readiness here means *attached to the broker and consuming*, which is the condition that otherwise fails silently. |

```bash
curl -s localhost:3000/health/ready | jq
curl -s localhost:3000/health/workers | jq
curl -s localhost:3000/metrics | grep '^job_'
curl -s localhost:9101/health/ready | jq          # with the worker running
```

**Retries and dead letters.** A job whose outcome could not be established is parked in `<queue>.retry.<n>`, whose TTL returns it to the work queue. Watch the tiers and the dead-letter queue together — depth in tier three means a dependency has been down for minutes, and anything in `.dlq` is a job that gave up:

```bash
docker exec irismono-rabbitmq rabbitmqctl list_queues name messages | grep -E 'retry|dlq'
```

**What to alert on.** `queue_messages_ready` with `queue_consumers` at zero is a stopped fleet; the same depth with healthy consumers is real demand, and the two want opposite responses. `job_queue_wait_seconds` is the better autoscaling signal of the two because it is denominated in what the customer waits for. Any non-zero depth on a `.dlq` queue is work that was accepted, charged for, and abandoned. `db_pool_connections{state="waiting"}` above zero means the pool is the bottleneck, which presents as uniform latency across unrelated endpoints.

**Correlation ids.** Every response carries `x-request-id`, and an inbound one is honoured. The id follows the job onto the queue and back through the worker's report, so one grep reconstructs a job across the API, the broker, and the GPU tier:

```bash
grep 5511cb2d api.log worker.log
```

Set `LOG_FORMAT=json` for shipper-readable output.

**Securing the ops endpoints.** `/metrics` and `/health/workers` describe internal topology — how many instances run, which model versions are deployed, how much capacity is idle, how far behind the queue is. Set `METRICS_TOKEN` wherever the scrape crosses a network you do not control; the endpoints then require it as a bearer token, and readiness stops returning dependency error strings to unauthenticated callers. Left unset they are open and the API warns at startup.

**Shutdown.** SIGTERM fails readiness first, waits `SHUTDOWN_DRAIN_MS`, then closes the listener and releases the broker and pools. In an orchestrator set the drain above the load balancer's health-check interval — the pod is removed from the endpoint list and signalled at the same moment, and traffic keeps arriving until the balancer notices. Note that Windows has no real SIGTERM: Node terminates unconditionally there and the handler does not run.

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
