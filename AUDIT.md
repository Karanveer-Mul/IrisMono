# IrisMono — System Audit

**Date:** 2026-08-06
**Commit audited:** `9b53949` (initial snapshot)
**Scope:** Full system — design, backend, frontend, schema, infrastructure.
**Mandate:** Documentation only. No backend code was changed as part of this audit. The one exception is the frontend, which was separately migrated to Next.js; findings resolved by that migration are marked accordingly.

---

## 1. What this project is

A B2B SaaS platform for medical/hospital customers that generates image masks from uploaded scans using GPU-bound ML models. Multi-tenant: an `Organization` owns a shared pool of credits; `Users` belong to one organization with role `ORG_ADMIN` or `MEMBER`. Processing is asynchronous — the browser uploads directly to object storage, a job is queued, a GPU worker consumes it, and the result is pushed back over Server-Sent Events.

Source of truth for intent is two documents in the repo root:

- `arch.md` — the original architect prompt stating requirements (§1 core functionality, §2 multi-tenancy, §3 registration/invites, §4 credit logic).
- `architecture_specification.md` — the resulting design: PostgreSQL DDL, block diagram, and credit-transaction pseudocode.
- `initial_backend` — a walkthrough claiming a green end-to-end integration run.

As built:

| Component | Implementation |
|---|---|
| Backend API | Express 4 + Drizzle ORM + node-postgres + amqplib, TypeScript/CommonJS. Routers `auth`, `jobs`, `invites`; in-memory SSE hub. |
| GPU worker | `backend/src/worker.ts` — RabbitMQ consumer simulating the model with a 5s sleep and a ~90% success roll. |
| Frontend | React 19 + Vite 8 (now migrated to Next.js). No router; `Auth` / `Dashboard` / `MaskUploader` / `InviteManager`; hand-rolled `apiFetch` + localStorage JWT. |
| Object storage | Mocked to the local filesystem at `uploads/`. Real S3 code paths exist but are bypassed when `AWS_ACCESS_KEY_ID === "mock-key-id"`. |
| Infrastructure | `backend/docker-compose.yml`: postgres:15-alpine, rabbitmq:3-management-alpine. |

**Headline finding: the system does not currently run.** The backend fails TypeScript compilation on a wrong-package import, and before the frontend migration every browser-originated POST sent a malformed request body. The green run recorded in `initial_backend` was produced by a script that bypasses the broken client code path, and predates the import that now breaks the build.

---

## 2. Architecture critique

These are problems with the *design*, not the code. They would survive fixing every defect in §4.

### What the design gets right

- **Asynchronous request-reply is correct for the workload.** Multi-second to multi-minute GPU jobs must not hold an HTTP connection.
- **Presigned direct-to-storage upload is the right call.** Medical scans are large; routing them through the API process would make the API a bandwidth and memory bottleneck for no benefit.
- **`SELECT ... FOR UPDATE` is the right concurrency primitive** for the credit balance, and the design identifies the race correctly.
- **Reserve-then-refund is better than the spec's own requirement.** `arch.md` §4 mandates "credits are deducted ONLY upon successful completion." That cannot prevent overdraft: with 1 credit remaining, N concurrent jobs all pass an availability check, all succeed, and the balance goes negative or the org gets free work. `architecture_specification.md` §3 overrides this as "Option A" (reserve at queue time, refund on failure), which is correct. **Do not let anyone "fix" this back into the spec's wording** — the divergence is deliberate and right.

### 2.1 Credits are modeled as a mutable integer — wrong primitive

`organizations.credit_balance` is a counter that is incremented and decremented in place. There is no ledger. For a billing system in a regulated domain, this is the most fundamental design flaw:

- **No history.** `arch.md` §"Jobs Table" promises metadata "maintained indefinitely for auditing/billing", but the balance itself has zero audit trail. There is no way to answer "why is this organization at 47 credits?"
- **Refunds are not idempotent.** A redelivered queue message runs the refund path twice and credits the organization twice. Nothing ties a refund to a specific state transition.
- **Reservations never expire.** See §4 "credit accounting" — a reserved-but-abandoned job strands a credit permanently.
- **No timeout enforcement**, despite `arch.md` §4 explicitly naming "fails or times out" as a state that must not consume credit.

**Recommendation:** append-only `credit_transactions (id, organization_id, job_id, delta, reason, created_at)` with a unique constraint on `(job_id, reason)`. Balance is then derived, or materialized on `organizations` and reconcilable against the ledger. This makes refunds idempotent for free — the second attempt violates the unique constraint and is a no-op.

### 2.2 Privilege inversion — the GPU worker writes the billing table

`worker.ts:67-132` holds full database credentials and directly mutates `organizations.credit_balance`. GPU workers are the least-trusted tier in this architecture: most horizontally scaled, most likely to run third-party model code, most likely to be preempted or run on spot capacity. Giving that tier write access to billing state is backwards.

The design's own block diagram gets this right — step 6 shows the worker reporting completion to the Backend API, which owns finalization and notification. **The implementation diverged from its own blueprint.** The worker should hold queue credentials plus scoped object-storage access, and nothing else.

### 2.3 The in-process SSE hub defeats the architecture it serves

`src/sse/index.ts` is a `Map` in Node process memory. Consequences:

- **It cannot survive a second API instance.** Clients connected to instance A never receive events published on instance B. Horizontal scalability is the entire justification for the async design, and the notification layer cannot participate in it.
- **The worker holds its own separate hub instance** (see §4), so worker broadcasts reach zero browsers today.
- **No `Last-Event-ID`, no replay.** A client that disconnects during a two-minute job never learns the outcome. SSE without replay is not a reliable delivery channel.

Because the missing replay forces a polling fallback regardless, and the product processes one image at a time per user, SSE is currently buying less than it costs. Either commit properly — Redis pub/sub, a persisted event log, `Last-Event-ID` resume — or drop to status polling with backoff and delete the complexity.

### 2.4 The three-step upload handshake is client-driven and fragile

`POST /request` → `PUT` to storage → `POST /:jobId/trigger`. The browser is load-bearing for server state transitions:

- Client reserves and never triggers (closes the tab) → credit stranded, job `PENDING` forever.
- Client triggers without uploading → worker pulls a missing object, burns a dispatch, fails, refunds.
- **Nothing validates the uploaded object.** The presigned PUT sets only `ContentType` (`jobs.ts:123-127`) — no size ceiling, no content verification. For a product accepting arbitrary uploads into your own bucket, that is a hole. Presigned POST with a `content-length-range` condition is the correct primitive.

**Recommendation:** drive dispatch from a storage event notification (S3 event → queue, or MinIO bucket notification locally). Upload completion *becomes* the trigger, the third round trip disappears, and the client stops being load-bearing.

### 2.5 The RLS design would not work even if it were applied

`architecture_specification.md` §1 defines policies keyed on `current_setting('app.current_organization_id')`. Two problems beyond the fact that none of it is in the migration:

1. **Connection pooling makes this actively dangerous.** The app uses a shared `pg.Pool` (`src/db/index.ts:10`). Setting a session variable outside a transaction persists on that pooled connection and leaks to the *next request that borrows it* — a cross-tenant read that looks safe because "RLS is enabled." The correct pattern is `SET LOCAL` inside every transaction, or a connection per tenant.
2. **Policies are inert against the table owner** unless `FORCE ROW LEVEL SECURITY` is set. The app connects as `postgres` (`docker-compose.yml`), which owns the tables. Even applied correctly, every policy would be bypassed.

### 2.6 "Hospital-grade security" reduces to a domain whitelist

`arch.md` §3 uses the phrase "Hospital-Grade Security" and then defines it as validating the string after the `@`. That control stops very little: any holder of a matching address self-serves an account through a reusable link with no admin approval, no per-invite use cap, and no record of who joined via which link.

Absent from the design entirely: encryption at rest (no KMS, no per-tenant keys), SSO/SAML, MFA, session policy, PHI handling, DICOM de-identification, immutable audit logging, BAA scope, breach-notification hooks, and the data retention the spec itself requires. S3 prefix segregation (`org_id=<uuid>/…`) is good hygiene, but **a prefix is a naming convention, not a boundary** — it isolates nothing unless an IAM or bucket policy enforces it, and nothing does.

For a product whose entire market is hospitals, this is the largest gap in the document.

### 2.7 The identity model is too rigid for real customers

`users.organization_id` is a single nullable FK, `users.email` is globally unique, and `role` lives on the user row. Therefore:

- **One person cannot belong to two organizations.** Consulting radiologists and multi-site hospital networks are the normal case, not the edge case.
- **A user who joins the wrong organization has no path out** except account deletion.
- **Role cannot differ per organization**, because it is not on the relationship.

**Recommendation:** a `memberships (user_id, organization_id, role)` join table. Separately, `organizations → jobs ON DELETE CASCADE` destroys the billing trail the spec promises to retain indefinitely; that relationship should be `RESTRICT` plus soft-delete on organizations.

### 2.8 Queue topology does not scale the way it intends

`queue-vip-${orgId}` (`jobs.ts:177`) means one queue per VIP tenant: unbounded queue proliferation and a consumer topology that must be reconfigured on every enterprise sale. Prefer a small fixed set of tiers routed by an `infrastructure_tier` column, or a single queue with message priorities.

Also missing at the design level: dead-letter queue, retry policy with backoff, and an idempotency key on the job message so that redelivery cannot double-process or double-refund.

### 2.9 The jobs table cannot support the business

No `model_version`, no `gpu_seconds`, no `worker_id`, no processing duration.

**`model_version` is not optional in this domain.** For any clinical or quasi-clinical use, you must be able to state which model produced which mask, for every mask, indefinitely. Retrofitting it means every historical mask is unattributable. This should be added before the first real customer, not after.

`gpu_seconds` matters because 1 credit = 1 image is mispriced by orders of magnitude between a chest X-ray and a full CT volume. Record it now even if billing stays flat.

### 2.10 No operational surface

No worker health check, no metrics, no tracing, no queue-depth signal, no autoscaling input. GPU capacity is the dominant cost line in this architecture and the design is silent on how many workers run or what scales them — warm pool versus scale-to-zero is the single largest cost decision here and it is unaddressed.

### Design fix ordering

Distinct from the defect ordering in §6, because these are larger changes:

1. **Credit ledger** (§2.1) — correctness and auditability; everything else in billing depends on it.
2. **Worker stops touching the database** (§2.2) — fixes the trust boundary and the dead SSE hub in one change.
3. **RLS done properly with `SET LOCAL` + `FORCE ROW LEVEL SECURITY`** (§2.5) — the failure mode here ends the company.
4. **Storage-event-driven dispatch** (§2.4).
5. **`model_version` on jobs** (§2.9) — cheap now, impossible to backfill later.
6. **The encryption, SSO, and audit work that "hospital-grade" actually implies** (§2.6).

Three items appear in both this section and §4 because the design flaw and the shipped defect are the same thing: the in-process SSE hub, the worker's direct database writes, and the missing RLS. They are not duplicate findings.

---

## 3. Verified evidence

Both commands run at commit `9b53949`.

`cd backend && npx tsc --noEmit` — 7 errors:

```
src/queue/index.ts(10,5): error TS2739: Type 'ChannelModel' is missing the following properties from type 'Connection': serverProperties, expectSocketClose, sentSinceLastCheck, recvSinceLastCheck, sendMessage
src/queue/index.ts(11,21): error TS18047: 'connection' is possibly 'null'.
src/queue/index.ts(11,32): error TS2339: Property 'createChannel' does not exist on type 'Connection'.
src/queue/index.ts(14,11): error TS18047: 'channel' is possibly 'null'.
src/queue/index.ts(18,5): error TS18047: 'connection' is possibly 'null'.
src/queue/index.ts(23,5): error TS18047: 'connection' is possibly 'null'.
src/routes/invites.ts(1,34): error TS2307: Cannot find module 'react-router' or its corresponding type declarations.
```

`cd frontend && npx tsc -b --noEmit` — 10 errors (pre-migration):

```
src/App.tsx(1,8): error TS6133: 'React' is declared but its value is never read.
src/App.tsx(4,41): error TS1484: 'UserContext' is a type and must be imported using a type-only import when 'verbatimModuleSyntax' is enabled.
src/components/Auth.tsx(2,51): error TS1484: 'UserContext' is a type and must be imported using a type-only import when 'verbatimModuleSyntax' is enabled.
src/components/Dashboard.tsx(1,8): error TS6133: 'React' is declared but its value is never read.
src/components/Dashboard.tsx(2,33): error TS1484: 'UserContext' is a type and must be imported using a type-only import when 'verbatimModuleSyntax' is enabled.
src/components/InviteManager.tsx(23,10): error TS6133: 'loading' is declared but its value is never read.
src/components/InviteManager.tsx(62,11): error TS2353: Object literal may only specify known properties, and 'action' does not exist in type 'ReadableStream<any> | Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer> | FormData | URLSearchParams'.
src/components/InviteManager.tsx(82,11): error TS2353: Object literal may only specify known properties, and 'action' does not exist in type 'ReadableStream<any> | Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer> | FormData | URLSearchParams'.
src/components/MaskUploader.tsx(3,32): error TS6133: 'ImageIcon' is declared but its value is never read.
src/components/MaskUploader.tsx(260,14): error TS2304: Cannot find name 'Sparkles'.
```

Note that TypeScript caught the malformed-request-body bug (`TS2353` above) at the two call sites that pass a typed object literal. It could not catch it at `Auth.tsx:51`, where the payload is typed `any`.

---

## 4. Findings

### BLOCKER — the backend does not compile

**`backend/src/routes/invites.ts:1`**

```ts
import { Router, Response } from "react-router"; // wait, express router!
```

`react-router` is not a dependency, is not installed, and is not a server framework. Line 2 already imports the correct `Router as ExpressRouter` from express, so line 1 is dead — but it is still a fatal module resolution error. `Response` is used only as a type annotation on handler signatures and should come from `express`.

The trailing comment suggests the author noticed mid-edit and never finished the correction.

*Fix:* delete line 1; add `Response` to the express import on line 2. One-line change, and it unblocks everything else.

### BLOCKER — every browser-originated POST sent a malformed body

**`frontend/src/utils/api.ts:59-91`** (pre-migration)

`apiFetch` spreads `options` into the fetch config without serializing `options.body`:

```ts
const config: RequestInit = { ...options, headers };
const response = await fetch(path, config);
```

Callers pass plain objects — `Auth.tsx:51`, `InviteManager.tsx:59`, `InviteManager.tsx:79`. `fetch` stringifies a non-`BodyInit` object via `toString()`, producing the literal `[object Object]`, which `express.json()` then rejects. Login, workspace creation, invite join, and domain add/remove were all broken **from the UI**.

`backend/src/test-flow.ts:19` performs its own `JSON.stringify`, which is precisely why the integration run recorded in `initial_backend` passed while the application did not. **A test that bypasses the client's own transport layer cannot validate that transport layer.**

*Status:* **resolved** by the Next.js migration — `frontend/lib/api.ts` now serializes object bodies.

### BLOCKER — real-time updates never connect

`backend/src/routes/jobs.ts:62` applies `router.use(authenticateJWT)` to every route below it, including the SSE endpoint at `jobs.ts:202`. That middleware accepts credentials **only** via the `Authorization: Bearer` header (`middleware/auth.ts:16-22`).

The browser opens the stream with `new EventSource("/api/jobs/events")` (`Dashboard.tsx:76`, pre-migration). **The `EventSource` API cannot set request headers.** Every connection attempt receives 401, `onerror` fires, and the handler closes the stream permanently. The entire SSE leg of the specification is non-functional in a browser; the dashboard updates only through its own manual `loadProfileAndLogs()` calls.

Two standard remedies, neither implemented:

- Issue a short-lived, single-purpose stream token and pass it as a query parameter, validated separately from the main JWT.
- Move authentication to an httpOnly cookie, which `EventSource` sends automatically (requires `withCredentials` and CORS work if origins ever split).

*Status:* **resolved.** `POST /api/auth/stream-token` mints a 60-second token carrying `purpose: "stream"`; the SSE route authenticates from `?token=`, and `authenticateJWT` explicitly refuses stream tokens so a leaked URL cannot be replayed against the rest of the API.

### BLOCKER — results are never actually displayed

`jobs.ts:32` defines only `PUT /api/jobs/mock-upload/:jobId`. **No route serves the `uploads/` directory for reading.** The success panel points both `<img>` tags at that PUT-only path (`MaskUploader.tsx:216`, `:227`), so both 404 and fall back to an external `placehold.co` URL.

Compounding it, both panes reference the *same* image, with the mask pane faking a visual difference via `filter: hue-rotate(180deg) saturate(3)` (`MaskUploader.tsx:230`). The mask the worker actually wrote to `uploads/<jobId>-mask.png` is never rendered anywhere in the product.

*Status:* **resolved.** `GET /api/jobs/:jobId/image/:kind` serves the stored PNG after confirming the job belongs to the caller's organization. The client fetches it as a blob (`JobImage.tsx`) because an `<img src>` cannot carry the Bearer header.

### HIGH — crash on the failure path

**`frontend/src/components/MaskUploader.tsx:260`** uses `<Sparkles size={18} …>` in the "Processing Failed" panel, but the lucide-react import at line 3 does not include it. Any `FAILED` job throws a `ReferenceError` while rendering.

This is on a live path, not a dead one: `worker.ts:52` simulates failure at roughly 10% (`Math.random() > 0.1`). Roughly one upload in ten would have crashed the panel that exists specifically to reassure the user their credit was refunded.

*Status:* **resolved** by the Next.js migration.

### HIGH — the applied schema drifts from the specification

`backend/src/db/migrations/0000_clammy_stick.sql` creates tables and foreign keys and nothing else. Missing against `architecture_specification.md` §1:

| Specified | Present in migration |
|---|---|
| `idx_users_org`, `idx_invites_code`, `idx_jobs_org`, `idx_jobs_user`, `idx_jobs_status` | None |
| `CONSTRAINT positive_credit_balance CHECK (credit_balance >= 0)` | No |
| `ALTER TABLE … ENABLE ROW LEVEL SECURITY` (users, jobs, organization_invites) | No |
| `tenant_isolation_users` / `_jobs` / `_invites` policies | No |

The indexes are a performance concern. **The RLS omission is a security concern**, and was the most consequential item in this audit: tenant isolation rested entirely on hand-written `eq(table.organizationId, orgId)` predicates in application code. A single forgotten predicate in a single query is a cross-tenant data leak in a product handling medical images. RLS exists precisely so that this class of mistake fails closed.

See §2.5 — the specified policies also would not have functioned as written even if applied.

*Status:* **resolved.** Indexes and the CHECK constraint in migration `0001`; RLS, roles, and policies in `0002`. See "How RLS was implemented" in §7.

### MEDIUM — the worker writes the database directly, and its SSE broadcasts reach nobody

`worker.ts:67-132` runs the settle/refund transaction itself and calls `sseHub.broadcastToOrg` in-process. `architecture_specification.md` step 6 assigns both responsibilities to the Backend API.

The immediate operational consequence: `npm run dev` (API) and `npm run worker:dev` (worker) are separate processes, each importing `src/sse/index.ts` and therefore each holding **its own** `SSEHub` instance with its own connection map. Browser clients register on the API's hub. The worker broadcasts to its own, which has zero connections. **Every worker notification is discarded**, and would be even if the SSE authentication issue in §4 were fixed.

See also §2.2 (trust boundary) and §2.3 (scalability).

### MEDIUM — credit accounting edge cases

The core reservation at `jobs.ts:74-113` is correct: it opens a transaction, takes `SELECT … FOR UPDATE` on the organization row, checks the balance, decrements, and inserts the job. The race the spec worried about is genuinely closed. The gaps are around it:

- **Abandoned reservations leak credits.** A job created by `POST /request` that is never triggered stays `PENDING` forever with its credit consumed. No reaper, no TTL, no expiry column. Closing the browser tab after the storage upload is enough to trigger this.
- **A worker crash leaks a credit.** If the process dies between consuming and completing, the job stays `PROCESSING` with no timeout to reclaim it.
- **No dead-letter queue.** `channel.ack(msg)` sits in a `finally` block (`worker.ts:148`), so a message that throws during handling is acknowledged and discarded regardless. A poison message is silently lost rather than parked for inspection.
- **No database-level floor.** With the `CHECK (credit_balance >= 0)` constraint absent from the migration, the only overdraft guard is the application check at `jobs.ts:88`. Any future code path that decrements without that check can drive the balance negative.

### MEDIUM — amqplib typing and null-safety

`src/queue/index.ts:5-11` declares `let connection: amqp.Connection`, but amqplib ≥ 0.10.5 returns `ChannelModel` from `connect()` — the source of 6 of the backend's 7 compile errors. Module-level `channel` is nullable and dereferenced without guards at lines 14, 18, and 23.

Separately, `worker.ts:16` opens its own independent connection rather than reusing this module, so connection lifecycle and reconnect logic are implemented twice with different semantics (the queue module retries via `reconnect()`, the worker via `setTimeout(startWorker, 5000)`).

### LOW — authentication and validation gaps

- **Hardcoded secret fallback.** `routes/auth.ts:11` and `middleware/auth.ts:4` both default `JWT_SECRET` to `"super-secret-medical-saas-key-change-in-production"`. A deployment missing the environment variable starts successfully and signs tokens with a secret published in the source tree. This should throw on startup instead.
- **No password policy, no rate limiting, no lockout.** `POST /api/auth/login` (`auth.ts:182`) will accept unlimited attempts.
- **Open registration.** `POST /api/auth/register` (`auth.ts:18`) lets anyone create an organization and self-assign `ORG_ADMIN` plus 3 credits, unbounded. Reasonable as a trial funnel; worth recording as an accepted risk with an abuse ceiling in mind.
- **Wildcard semantics are broader than they look.** `utils/domain.ts:24` matches when `emailDomain === pattern || emailDomain.endsWith("." + pattern)`. A bare `stjude.org` therefore also admits `research.stjude.org` — a plain domain behaves like `*.stjude.org`. This matches the behavior exercised in `test-flow.ts` and is probably intended, but an administrator typing an exact domain would not expect subdomain admission. Documented as behavior, not a bug; the UI should say so.
- **No CORS middleware** in `src/index.ts`. This works only because the dev server proxies `/api` to the same origin — true for the old Vite proxy and for the current Next.js rewrite. Any split-origin deployment breaks immediately.
- **JWT in localStorage** is XSS-readable and cannot be revoked before its 24h expiry. Acceptable for now; noted because it is also the reason the SSE fix is blocked.

### LOW — unimplemented specification items

- **Data retention is entirely absent.** `arch.md` §1 requires configurable storage cleanup via S3 lifecycle rules. Nothing implements, configures, or documents it. For medical data this is both a compliance and a cost item.
- **VIP routing is a stub that ships.** `jobs.ts:176` selects the tier with `org?.name.toLowerCase().includes("vip")` — there is no tier column. Worse, `worker.ts:10` consumes only `queue-standard-jobs`, so **any job routed to a VIP queue hangs in `PENDING` forever with its credit reserved.** An organization named "VIP Medical Center" would silently never process a single image.
- **Role enforcement is partial.** `requireRole` (`middleware/auth.ts:39`) is applied only to `/api/invites`. `jobs.ts` has no role differentiation. The resulting behavior happens to match the spec (MEMBER may upload and view logs), but by omission rather than by design.

### INFORMATIONAL

- **The recorded verification is stale.** `initial_backend` documents a green end-to-end run, but that run predates the `react-router` import that now breaks the build, and it exercised the API through `test-flow.ts` rather than the browser. Its "INTEGRATION TEST COMPLETED SUCCESSFULLY" should not be read as current status.
- `uploads/` contains artifacts from job `15c325f6-f023-4024-ba6c-6ed2b37cf54a`. The raw and mask files are byte-identical, because `worker.ts:62` produces the mask with `fs.copyFileSync(rawPath, maskPath)`.
- **No pagination on `GET /api/jobs/logs`** (`jobs.ts:213`). It returns every job the organization has ever run, and the dashboard refetches it in full on mount and after every SSE event. Unbounded growth on a hot path.
- **No `GET /api/jobs/:id`.** The client fetches the entire log list and finds its job by id (`Dashboard.tsx:60`, `:106-111`), including inside a 500ms `setTimeout` race after job creation.
- **The one-image-at-a-time rule is client-side only.** `MaskUploader` checks `files.length !== 1`; the server enforces no per-organization concurrency limit. `arch.md` §1 describes it as a configuration-driven restriction; it is a hardcoded UI check.
- **Version skew.** `frontend` pins TypeScript `~6.0.2` and Vite `^8.1.1` while `backend` uses TypeScript `^5.5.2`. Not currently harmful — the two build independently — but worth aligning.

---

## 5. Specification conformance

Against `arch.md`. "Partial" means implemented with a material caveat documented above.

| # | Requirement | Status | Evidence |
|---|---|---|---|
| §1 | Asynchronous request-reply | ✅ | `jobs.ts`, `queue/index.ts`, `worker.ts` |
| §1 | React SPA frontend | ✅ | `frontend/` (now Next.js) |
| §1 | Exactly 1 image at a time, config-driven | ⚠️ Partial | Client-only check, `MaskUploader.tsx:64`; no server limit, not configurable |
| §1 | Presigned URL, direct-to-storage upload | ⚠️ Partial | `jobs.ts:123-128`; mocked locally, no size/content conditions |
| §1 | Isolated GPU worker containers via message queue | ⚠️ Partial | `worker.ts` consumes RabbitMQ, but simulates the model and is not containerized |
| §1 | Real-time notification via SSE | ❌ Broken | `EventSource` cannot send Bearer; hub is per-process — §4 |
| §1 | Configurable data retention / lifecycle rules | ✅ | `src/retention.ts`, `STORAGE_RETENTION_DAYS`; bucket lifecycle equivalent documented for real S3 |
| §2 | Organization owns shared credit pool | ✅ | `schema.ts:9-16` |
| §2 | Roles `ORG_ADMIN` / `MEMBER` | ⚠️ Partial | Enum + `requireRole` exist; enforced only on `/api/invites` |
| §2 | S3 paths segregated by organization UUID | ✅ | `jobs.ts:99` — `org_id=<uuid>/jobs/<uuid>/raw.png` |
| §2 | Schema ready for RLS on `organization_id` | ✅ | Enforced, not merely ready: migration `0002`, `withTenant()` in `src/db/index.ts`, regression test `npm run test:rls` |
| §3 | First signup creates org + grants `ORG_ADMIN` | ✅ | `auth.ts:41-77` |
| §3 | Seed exactly 3 trial credits | ✅ | `auth.ts:47`, `schema.ts:12` |
| §3 | Reusable invite link `/join/inv_<uuid>` | ✅ | `invites.ts:25`, `invites.ts:50` |
| §3 | `allowed_domains` array, backend-enforced | ✅ | `auth.ts:118-133`, `utils/domain.ts` — note subdomain semantics in §4 |
| §3 | Toggleable `is_active` panic/revoke | ✅ | `invites.ts:64-97`; verified in `initial_backend` step 11-12 |
| §4 | Credits deducted only on success | ↔️ Deliberate deviation | Reserve-at-queue + refund-on-failure. See §2 — the deviation is correct and endorsed by `architecture_specification.md` §3 |
| §4 | Row-level locking against concurrent exhaustion | ✅ | `jobs.ts:79-81` — `SELECT … FOR UPDATE` inside a transaction |
| §4 | Failed/timed-out job must not consume credit | ✅ | Failure refunds via the API report path; timeout and abandoned reservations both reclaimed by `src/reaper.ts` |

---

## 6. Recommended fix order

Implementation defects, ordered by unblocking value. Design work is ordered separately at the end of §2.

| # | Fix | Effort | Why here |
|---|---|---|---|
| ~~1~~ | ~~Delete the `react-router` import in `invites.ts:1`~~ | — | **Done.** Backend compiles and runs; end-to-end flow verified |
| ~~2~~ | ~~Add `GET /api/jobs/:jobId/image/:kind` serving `uploads/`, tenant-scoped~~ | — | **Done.** Tenant-scoped; cross-tenant reads 404, anonymous reads 401 |
| ~~3~~ | ~~Authenticate the SSE stream by a means `EventSource` can carry~~ | — | **Done.** 60s purpose-scoped stream token; rejected as a Bearer credential |
| ~~4~~ | ~~Worker reports completion to the API instead of writing the DB; one hub serves clients~~ | — | **Done.** Worker holds no DB credentials; events now reach browser clients |
| ~~5~~ | ~~Migration adding indexes, the `credit_balance >= 0` CHECK, and working RLS (`SET LOCAL` + `FORCE`)~~ | — | **Done.** Indexes and CHECK in `0001`; RLS in `0002`. Verified by `npm run test:rls` |
| ~~6~~ | ~~Correct amqplib types (`ChannelModel`) and null guards~~ | — | **Done.** `tsc --noEmit` is clean |
| ~~7~~ | ~~Reaper for abandoned `PENDING`/`PROCESSING` jobs; DLQ~~ | — | **Done.** `src/reaper.ts`, dead-letter topology in `src/queue/index.ts`. Verified by `npm run test:lifecycle` |
| ~~8~~ | ~~S3 lifecycle/retention rules; real VIP consumer or remove the routing stub~~ | — | **Done.** `src/retention.ts`; tier column replaces the name-substring stub, VIP is a real queue a dedicated pool consumes |
| — | ~~`apiFetch` body serialization~~ | — | **Resolved** by the Next.js migration |
| — | ~~Missing `Sparkles` import~~ | — | **Resolved** by the Next.js migration |

---

## 7. How to reproduce this audit

```bash
cd backend  && npx tsc --noEmit     # 7 errors at 9b53949; 0 after fixes #1 and #6
cd frontend && npx tsc --noEmit     # 10 errors at 9b53949; 0 after the Next.js migration

# With docker compose up, the API, and the worker running:
cd backend
npm run test:flow        # end-to-end product flow
npm run test:rls         # tenant isolation, with predicates deliberately omitted
npm run test:lifecycle   # reaper, dead-lettering, tier routing
```

### How RLS was implemented

Enabling RLS is not additive — done partially it takes the system down, and done carelessly it produces the *appearance* of isolation without the substance. Three things had to land together, and did:

1. **Non-superuser database roles.** The app previously connected as `postgres`, a superuser, and **superusers bypass RLS unconditionally** — `FORCE ROW LEVEL SECURITY` closes the table-owner hole but not the superuser one, so the policies would have been silently inert. Migration `0002` creates `irismono_app` (no superuser, no `BYPASSRLS`) for runtime and `irismono_auth` (`BYPASSRLS`) for pre-tenant work. `postgres` is now used only for DDL, via `ADMIN_DATABASE_URL`.
2. **Transaction-scoped context.** `withTenant()` in `src/db/index.ts` opens a transaction and calls `set_config('app.current_organization_id', $1, true)` — `is_local => true`, so the setting dies with the transaction. A session-level `SET` on a pooled connection would leak one tenant's context into the next request that borrows it, which is worse than having no RLS at all. Every tenant-scoped query now runs inside it.
3. **A pre-tenant path.** Login, registration, and invite redemption identify a row by email or invite code *before* any organization is known; under RLS those queries return zero rows and nobody can sign in. They run on `systemDb` (the `BYPASSRLS` identity), as does the worker's job report, which knows only a job id and is gated by the worker shared secret.

`organizations` was added to the policy set even though the specification omitted it — it holds the credit balance, and a query that lost its predicate would otherwise read another tenant's billing state.

`npm run test:rls` (`src/test-rls.ts`) is the regression test. Every query in it deliberately omits the organization predicate, so it fails loudly if policies are dropped, if the app role regains superuser or `BYPASSRLS`, or if the context stops being applied. Observed: with 4 jobs across 5 organizations, a query with no context returns 0 rows; the same unscoped query inside tenant A's context returns only A's single job; tenant B's set is disjoint; a cross-tenant `UPDATE` matches 0 rows; and a fresh query after commit sees 0, confirming the context does not survive onto the pooled connection.

### Job lifecycle and retention (fixes #7 and #8)

`src/reaper.ts` sweeps on an interval and reclaims credits from jobs that will never finish: `PENDING` past `JOB_PENDING_TIMEOUT_MINUTES` (a reservation whose client never dispatched — closing the tab after the upload was enough) and `PROCESSING` past `JOB_PROCESSING_TIMEOUT_MINUTES` measured from the new `started_at` column, so a long queue wait is not mistaken for a stalled worker. The refund is issued by `UPDATE ... WHERE status = <expected>`, so if a worker settles the job first, zero rows match and no second refund happens. The specification required that a job which "fails or times out" not consume credit; only the failure half had ever been implemented.

Each tier queue now dead-letters to `jobs.dlx`. The worker retries a report in-process (transient errors only — a 409 is the API's considered answer and is not retried), and on exhaustion nacks without requeue so the message lands in `queue-standard-jobs.dlq` rather than being acked away in a `finally` block. The earlier hot-requeue loop is gone.

VIP routing was a stub that shipped: it keyed off `org.name.includes("vip")`, and no consumer existed for the per-tenant queue it produced, so such a job would sit `PENDING` forever with its credit reserved. Organizations now carry an `infrastructure_tier` column, and there is one queue per tier rather than one per tenant — a dedicated pool is started with `WORKER_QUEUES=queue-vip-jobs`.

`src/retention.ts` expires stored images after `STORAGE_RETENTION_DAYS`, leaving job metadata untouched because the specification keeps it indefinitely for billing and audit. On real S3 this sweeper is the wrong mechanism and the file documents the equivalent bucket lifecycle rule, which cannot be skipped by a process that failed to start.

`npm run test:lifecycle` covers all of it: a fresh job is left alone, an aged `PENDING` and an aged `PROCESSING` are both expired with exactly one credit returned, a second sweep does not double-refund, an unprocessable message reaches the DLQ, and a VIP tenant's job lands on the VIP queue.

**Status update.** All eight fixes have been applied. Four suites cover the result: `test:flow`, `test:rls`, `test:lifecycle`, and the ad-hoc verification described above. The backend compiles, starts, and passes `src/test-flow.ts` end to end — registration, domain whitelist enforcement, credit reservation, queue dispatch, GPU worker completion, and invite revocation all behave as specified, with the organization balance moving 3 → 2 on one successful job.

Additionally verified against the running stack: the SSE stream rejects an unauthenticated connection (401) and accepts a stream token, which is itself refused as a Bearer credential (403); a browser-side stream client receives both the `PROCESSING` and `SUCCESS` events the worker reports, confirming the notification path is genuinely restored; job images are served to their own tenant (200), refused anonymously (401), and refused across tenants (404); the worker report endpoint rejects a bad secret (401) and refuses a replayed report (409) without moving the balance.

Every remaining finding in this document stands as written and was verified against commit `9b53949`.

One further defect, found while re-verifying: **`src/test-flow.ts` was not idempotent.** It registered hardcoded email addresses, so a second run aborted at step 1 with `409 Email is already registered`. Now resolved — identities are stamped per run, and the suite passes twice in a row against a non-empty database.

Local infrastructure note: `docker-compose.override.yml` (gitignored) publishes the Postgres container on **5433**, because a locally installed PostgreSQL already occupies 5432 with different credentials. `DATABASE_URL` in `backend/.env` points there.
