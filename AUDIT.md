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

*Status:* **resolved.** Implemented as recommended — see "Credit ledger" in §7.

### 2.2 Privilege inversion — the GPU worker writes the billing table

`worker.ts:67-132` holds full database credentials and directly mutates `organizations.credit_balance`. GPU workers are the least-trusted tier in this architecture: most horizontally scaled, most likely to run third-party model code, most likely to be preempted or run on spot capacity. Giving that tier write access to billing state is backwards.

The design's own block diagram gets this right — step 6 shows the worker reporting completion to the Backend API, which owns finalization and notification. **The implementation diverged from its own blueprint.** The worker should hold queue credentials plus scoped object-storage access, and nothing else.

### 2.3 The in-process SSE hub defeats the architecture it serves *(resolved — see §7)*

`src/sse/index.ts` is a `Map` in Node process memory. Consequences:

- **It cannot survive a second API instance.** Clients connected to instance A never receive events published on instance B. Horizontal scalability is the entire justification for the async design, and the notification layer cannot participate in it.
- **The worker holds its own separate hub instance** (see §4), so worker broadcasts reach zero browsers today.
- **No `Last-Event-ID`, no replay.** A client that disconnects during a two-minute job never learns the outcome. SSE without replay is not a reliable delivery channel.

Because the missing replay forces a polling fallback regardless, and the product processes one image at a time per user, SSE is currently buying less than it costs. Either commit properly — Redis pub/sub, a persisted event log, `Last-Event-ID` resume — or drop to status polling with backoff and delete the complexity.

### 2.4 The three-step upload handshake is client-driven and fragile *(resolved — see §7)*

`POST /request` → `PUT` to storage → `POST /:jobId/trigger`. The browser is load-bearing for server state transitions:

- Client reserves and never triggers (closes the tab) → credit stranded, job `PENDING` forever.
- Client triggers without uploading → worker pulls a missing object, burns a dispatch, fails, refunds.
- **Nothing validates the uploaded object.** The presigned PUT sets only `ContentType` (`jobs.ts:123-127`) — no size ceiling, no content verification. For a product accepting arbitrary uploads into your own bucket, that is a hole. Presigned POST with a `content-length-range` condition is the correct primitive.

**Recommendation:** drive dispatch from a storage event notification (S3 event → queue, or MinIO bucket notification locally). Upload completion *becomes* the trigger, the third round trip disappears, and the client stops being load-bearing.

### 2.5 The RLS design would not work even if it were applied

`architecture_specification.md` §1 defines policies keyed on `current_setting('app.current_organization_id')`. Two problems beyond the fact that none of it is in the migration:

1. **Connection pooling makes this actively dangerous.** The app uses a shared `pg.Pool` (`src/db/index.ts:10`). Setting a session variable outside a transaction persists on that pooled connection and leaks to the *next request that borrows it* — a cross-tenant read that looks safe because "RLS is enabled." The correct pattern is `SET LOCAL` inside every transaction, or a connection per tenant.
2. **Policies are inert against the table owner** unless `FORCE ROW LEVEL SECURITY` is set. The app connects as `postgres` (`docker-compose.yml`), which owns the tables. Even applied correctly, every policy would be bypassed.

### 2.6 "Hospital-grade security" reduces to a domain whitelist *(partly resolved — see §7)*

`arch.md` §3 uses the phrase "Hospital-Grade Security" and then defines it as validating the string after the `@`. That control stops very little: any holder of a matching address self-serves an account through a reusable link with no admin approval, no per-invite use cap, and no record of who joined via which link.

Absent from the design entirely: encryption at rest (no KMS, no per-tenant keys), SSO/SAML, MFA, session policy, PHI handling, DICOM de-identification, immutable audit logging, BAA scope, breach-notification hooks, and the data retention the spec itself requires. S3 prefix segregation (`org_id=<uuid>/…`) is good hygiene, but **a prefix is a naming convention, not a boundary** — it isolates nothing unless an IAM or bucket policy enforces it, and nothing does.

For a product whose entire market is hospitals, this is the largest gap in the document.

### 2.7 The identity model is too rigid for real customers *(resolved — see §7)*

`users.organization_id` is a single nullable FK, `users.email` is globally unique, and `role` lives on the user row. Therefore:

- **One person cannot belong to two organizations.** Consulting radiologists and multi-site hospital networks are the normal case, not the edge case.
- **A user who joins the wrong organization has no path out** except account deletion.
- **Role cannot differ per organization**, because it is not on the relationship.

**Recommendation:** a `memberships (user_id, organization_id, role)` join table. Separately, `organizations → jobs ON DELETE CASCADE` destroys the billing trail the spec promises to retain indefinitely; that relationship should be `RESTRICT` plus soft-delete on organizations.

*Status:* **resolved.** Memberships in migration `0007`; the cascade in `0011` — see "Retention of record" in §7.

### 2.8 Queue topology does not scale the way it intends *(resolved — see §7)*

`queue-vip-${orgId}` (`jobs.ts:177`) means one queue per VIP tenant: unbounded queue proliferation and a consumer topology that must be reconfigured on every enterprise sale. Prefer a small fixed set of tiers routed by an `infrastructure_tier` column, or a single queue with message priorities.

Also missing at the design level: dead-letter queue, retry policy with backoff, and an idempotency key on the job message so that redelivery cannot double-process or double-refund.

### 2.9 The jobs table cannot support the business *(resolved — see §7)*

No `model_version`, no `gpu_seconds`, no `worker_id`, no processing duration.

**`model_version` is not optional in this domain.** For any clinical or quasi-clinical use, you must be able to state which model produced which mask, for every mask, indefinitely. Retrofitting it means every historical mask is unattributable. This should be added before the first real customer, not after.

`gpu_seconds` matters because 1 credit = 1 image is mispriced by orders of magnitude between a chest X-ray and a full CT volume. Record it now even if billing stays flat.

### 2.10 No operational surface *(resolved — see §7)*

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
| §1 | Real-time notification via SSE | ✅ | Stream-token auth, fanout across instances, `Last-Event-ID` replay — verified by `npm run test:sse` |
| §1 | Configurable data retention / lifecycle rules | ✅ | `src/retention.ts`, `STORAGE_RETENTION_DAYS`; bucket lifecycle equivalent documented for real S3 |
| §2 | Organization owns shared credit pool | ✅ | `schema.ts:9-16` |
| §2 | Roles `ORG_ADMIN` / `MEMBER` | ✅ | Role now lives on the membership, so it is per organization — `memberships` table, migration `0007` |
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
npm run test:credits     # ledger integrity, refund idempotency, reconciliation
# test:sse needs a second instance: PORT=3002 npx tsx src/index.ts
npm run test:sse         # cross-instance delivery and Last-Event-ID replay
npm run test:identity    # one account across organizations, role per membership
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

### Credit ledger (design item §2.1)

Migration `0004` adds append-only `credit_transactions (organization_id, job_id, delta, reason, note, created_at)`. `organizations.credit_balance` survives as a materialized total rather than the source of truth, because the reservation path needs `SELECT ... FOR UPDATE` on a single row to serialize concurrent spenders — summing the ledger under contention would need a heavier locking strategy for no benefit. The two move together inside one transaction, and `reconcile()` in `src/credits.ts` proves they agree.

The important part is the partial unique index on `(job_id, reason) WHERE job_id IS NOT NULL`. **Refund idempotency is now structural**: a replayed worker report or a reaper sweep overlapping a worker's own report hits a database constraint instead of moving the balance a second time. Call sites no longer have to remember — `refundCredit()` returns whether it actually refunded, and callers that care (the reaper's count) use that.

`credit_balance` previously defaulted to 3, which would have created credits with no entry behind them. New organizations now start at zero and receive their trial credits as a recorded `TRIAL_GRANT`, so **every credit in the system has a traceable origin**. Existing balances were seeded with a `BACKFILL` row so they reconcile from day one — 13 organizations, 30 credits, zero discrepancies at migration time.

All movement funnels through `src/credits.ts` (`reserveCredit`, `refundCredit`, `grantCredits`), and `GET /api/credits` exposes balance plus history to the tenant, which is the audit trail `arch.md` asks for and previously did not exist. The table carries the same RLS posture as every other tenant table.

`npm run test:credits` asserts the whole invariant: the trial grant is recorded rather than defaulted, a reservation links to its job, a failure refunds exactly once, a replayed refund returns false and writes nothing, a refused overdraft leaves no ledger row, entries sum to the stored balance, the endpoint agrees with the database, history does not leak across tenants, and every organization in the database reconciles.

### Job provenance (design item §2.9)

Migration `0005` adds `model_version`, `worker_id`, and `gpu_seconds` to `jobs`, with a partial index on `model_version`.

`model_version` is the one that had to happen before the next real customer: if a model build is later found defective, you must be able to identify every mask it produced. Retrofitting it leaves all existing masks unattributable. It is enforced rather than hoped for — **the API rejects a `SUCCESS` report that carries no model version with a 400**, so a worker deployed without `MODEL_VERSION` fails loudly instead of quietly generating untraceable masks. Failures record it too, since a version that fails often is exactly what you want to query for.

The recall path is `GET /api/jobs/logs?modelVersion=<version>`, backed by `idx_jobs_model_version`; operators can answer the same question across tenants directly against the index. The version and GPU time are surfaced in the job history table and the success panel, because a provenance record nobody can see is not much of a record.

`gpu_seconds` is recorded even though billing is flat at 1 credit per image. A chest X-ray and a full CT volume differ by orders of magnitude in compute, and the data has to exist before any metered pricing is possible.

Covered by `npm run test:lifecycle`: a `SUCCESS` with no model version is refused, provenance round-trips into the database, and the recall query isolates exactly the affected job. Confirmed end to end against the live worker, which stamps `irismono-seg-sim-0.1.0` and its host:pid.

### SSE bus and replay (design item §2.3)

Two separate defects lived in that one `Map`. Neither is fixed by the other.

**Cross-instance delivery.** Events are now published to a RabbitMQ fanout exchange (`sse.fanout`), and every API instance binds an exclusive, auto-deleted queue to it. An event published on any instance reaches the clients connected to all of them, so the notification layer can finally participate in the horizontal scaling that justifies the asynchronous design. A fanout exchange rather than Redis pub/sub: the stack already runs a broker, and adding a second piece of infrastructure to move a few hundred bytes per job is hard to justify.

**Replay.** Migration `0006` adds `job_events`, an append-only log with a monotonic id, written *before* the fan-out. The stream emits `id:` on every event and honours `Last-Event-ID` on connect, replaying anything the client missed. A client that dropped during a two-minute job now learns the outcome on reconnect instead of waiting for a poll. The connection is registered before the replay query runs and buffers live events until the replay finishes, so an event arriving mid-replay cannot fall through the gap; the client's `deliveredThrough` watermark suppresses duplicates.

The browser reconnects by hand rather than letting `EventSource` do it, because each attempt needs a fresh stream token — so it passes `lastEventId` itself, with capped exponential backoff.

The event log is pruned after `EVENT_LOG_RETENTION_DAYS` (default 7). It only has to outlive a disconnected client; `jobs` and `credit_transactions` remain the durable record.

Recording the event and pushing it are deliberately not atomic. The append is what makes an event real: if the broker is down, live clients miss the push, but a reconnecting client still replays it and polling callers still see the job state. Losing the push is degraded service, not lost data.

`npm run test:sse` is the proof, and it needs two API instances (`PORT=3002 npx tsx src/index.ts`) — a single-process test could not distinguish this from the old hub. It asserts that an event published on instance B reaches a client connected to instance A, that a job completed while the client was disconnected is replayed on reconnect, that already-seen events are not resent, and that live delivery resumes afterwards.

### Identity model (design item §2.7)

Migration `0007` introduces `memberships (user_id, organization_id, role)`, backfills every existing user into it (47 rows), and then **drops `users.organization_id` and `users.role`**. Dropping them is the point: leaving them would let code keep reading "the" organization for a user, which is exactly the assumption being removed.

A user is now a person, not a seat. The same account can be `ORG_ADMIN` at their own practice and `MEMBER` at a hospital, which is the normal case for consulting radiologists and multi-site networks rather than an edge case.

**Sessions stay scoped to one organization.** The JWT still carries a single `organizationId` and `role`, so every downstream route reads `req.user.organizationId` unchanged and the RLS context remains one unambiguous value per request. Switching is `POST /auth/switch-organization`, which re-checks the membership server-side and mints a new token — a token cannot be minted for a tenant the caller does not belong to.

**Joining while already registered now works.** Previously a known email was a flat 409. It now adds a membership, once the password proves who is asking — an email address alone cannot attach someone else's account to your organization.

**The `users` RLS policy had to change shape**, because the table no longer carries a tenant. It now asks the membership table: a user row is visible to exactly those organizations the person belongs to. `test:rls` asserts user visibility tracks membership count, and `test:identity` confirms an unrelated organization reads zero rows for a person it does not employ.

The dashboard header becomes an organization switcher when there is more than one membership; the component is remounted on change so no state from the previous tenant survives.

`npm run test:identity` covers the whole shape: one account in two organizations with different roles, a single `users` row rather than a duplicate, an impostor with the wrong password refused, admin powers *not* travelling between organizations (`ORG_ADMIN` in one, 403 on the same admin action in the other), switching refused for non-members, membership lists isolated per tenant, and removing one membership leaving the account and the other membership intact.

### Operational surface (design item §2.10)

The system had no way to answer "is it working" other than using it. The old `/health` returned `{"status":"healthy"}` unconditionally — it could not fail, which made it worse than absent, because an orchestrator would treat a process with a dead database as healthy forever.

**Liveness and readiness are now separate, and only readiness consults dependencies.** `GET /health` proves the process still runs a handler. `GET /health/ready` probes `postgres_app`, `postgres_auth`, and `rabbitmq`, each with a 2-second ceiling, and answers 503 if any fails. Wiring dependency checks into liveness is a well-known way to convert a brief database blip into a rolling restart of every instance — removing the capacity that would have absorbed it.

Both database identities are probed, not one. They are separate roles with separate grants, and the app role losing access while the system role keeps working is precisely the failure a single probe misses: it presents as tenant queries returning nothing, which reads as empty data rather than an outage.

**`GET /metrics` exposes 24 metric families in Prometheus text format**, from a hand-rolled registry (`src/observability/metrics.ts`) rather than `prom-client` — the same reasoning as the hand-rolled SSE hub and ledger, and the note in that file says to swap in `prom-client` rather than extend this if it ever needs exemplars or native histograms. Beyond process and HTTP metrics, the ones that describe the business: `job_queue_wait_seconds` (reservation → claim, labelled by tier), `job_duration_seconds`, `job_gpu_seconds`, `job_reports_total`, `job_reports_rejected_total`, `jobs_reaped_total`, `credit_movements_total`, `queue_messages_ready`, `queue_consumers`, `db_pool_connections`, and `sse_connections`.

**Cardinality is bounded structurally, not by discipline.** Route labels are the matched Express *pattern*, never the URL — `/api/jobs/:jobId/image/:kind`, not the job id — and every metric refuses new label sets past 500 series with one loud error. An unbounded label is how a metrics backend gets taken down by the service it monitors, and it fails slowly enough to reach production. `test:observability` asserts a real job id never appears anywhere in the scrape.

**The worker is no longer invisible.** It opens no inbound socket in the course of its work, so a worker that stopped consuming an hour ago looked exactly like an idle one — discoverable only by noticing the queue growing. Two additions close that: a probe port (`WORKER_HEALTH_PORT`, default 9101) serving `/health`, `/health/ready`, and its own `/metrics`, where readiness means *attached to the broker and consuming*; and a heartbeat to `POST /api/workers/heartbeat` under the same shared secret as a job report, recorded in `worker_heartbeats` (migration `0008`).

The heartbeat is stored in Postgres rather than process memory for the same reason the SSE event log is: behind a load balancer a beat lands on one instance, and an in-memory fleet view would differ per instance and be wrong on all of them. Staleness is decided from `last_seen_at`, which the database stamps — a worker with a skewed clock cannot report itself alive. The table carries RLS enabled with **no policy**, so the tenant-scoped role reads zero rows from it; only the system identity sees it.

**Fleet health is deliberately not readiness.** An API with no workers can still authenticate, serve completed masks, and accept jobs into the queue; failing readiness would withdraw the part that still works. It is a separate endpoint and a separate alert.

**Correlation ids close the trace across four hops.** One image passes through the browser, the API, RabbitMQ, a worker, and back into the API on a different connection. The id is generated at the edge (or adopted from an upstream `x-request-id`), carried through the process by `AsyncLocalStorage`, published as the AMQP `correlationId`, echoed by the worker on its report, and returned in the response header. Verified end to end: a single id `5511cb2d` appears on the browser's `POST /trigger`, on both worker log lines, and on both of the worker's reports back. `LOG_FORMAT=json` switches the logger to shipper-readable output. OpenTelemetry is the production replacement; the field name is already the one it would use.

**Shutdown is ordered:** fail readiness → let the balancer notice (`SHUTDOWN_DRAIN_MS`) → stop accepting → finish in-flight → release broker and pools. Reversing any two drops work already accepted, and in this system an accepted request has usually already reserved a credit.

**Autoscaling input.** `queue_messages_ready` is the direct measure of owed GPU capacity, and `queue_consumers` disambiguates it: depth rising with consumers at zero is a stopped fleet, depth rising with consumers healthy is demand — opposite responses. `job_queue_wait_seconds` is the better scaling signal of the two because it is denominated in what the customer experiences. Dead-letter depth should alert at any non-zero value: a message there is work that was accepted, charged for, and abandoned.

**A latent bug surfaced while verifying this.** `job_queue_wait_seconds` recorded nothing after a real job. The cause was not the metric: `created_at` is generated by Postgres while `started_at` and `completed_at` were taken from the API's `new Date()`, and the Docker VM clock ran ~335 ms ahead of the host — so the interval between them came out negative and was discarded. Both timestamps are now `NOW()`. This mattered beyond the metric: the reaper compares `started_at` against `NOW()` in SQL, so its PROCESSING timeout was skewed by the same amount. The guard that dropped the negative value now logs instead, because a metric that silently discards its input is indistinguishable from one nothing is happening on — which is how this stayed hidden.

`/metrics` and `/health/workers` describe internal topology — instance count, deployed model versions, spare capacity, backlog — so `METRICS_TOKEN` gates them (constant-time comparison), and readiness redacts dependency error strings from unauthenticated callers. Left unset they are open and the process warns at startup; a silent default that looks secure is worse than a loud one.

`npm run test:observability` covers all fifteen behaviours, including that a heartbeated worker appears online, that a silenced one flips to offline in both the endpoint and the gauge, that a restarted worker replaces its row rather than duplicating it, and that draining fails readiness while liveness still passes. That last one is exercised in-process: Windows has no real SIGTERM, so Node terminates the target unconditionally and the handler never runs — signal delivery itself is a platform behaviour and is not asserted here.

### Retry policy, dispatch idempotency, and pagination (design item §2.8, plus the `/logs` scan)

Tier routing and the dead-letter queue landed with fixes #7 and #8. What §2.8 still called for was a retry policy with backoff and an idempotency key; both are now in place, and the unpaginated audit log went with them.

**Retries are tiered delay queues, not a redelivery loop.** A message whose outcome could not be established used to go straight to the dead-letter queue, needing a human, while the reaper quietly refunded the credit — so a thirty-second API redeploy destroyed jobs that would have succeeded on a second attempt. The worker now parks such a message in the next tier (`10s, 60s, 300s`, from `JOB_RETRY_DELAYS_MS`), and only dead-letters it once the tiers are spent.

Nothing consumes the delay queues. Each is declared with an `x-message-ttl` and a dead-letter route pointing back at its work queue, so **expiry is the redelivery** — no scheduler, no timer, no extra process. One queue per attempt rather than a per-message TTL on a single queue, because TTL is only honoured at the head: a five-minute message parked in front of a ten-second one would hold both for five minutes.

This is distinct from the worker's in-process report retries, which cover a few seconds of unavailability. These cover the longer failure — a redeploy, a database failover, a full disk.

**The retry would have been decorative without a matching claim rule.** The first attempt leaves the job `PROCESSING`, so the redelivered copy would have been refused and dropped, and the job would have sat until the reaper expired it. A worker re-claiming a job **it already owns** is now accepted as a retry. The rule is deliberately narrow: only a matching `worker_id`, so a delivery reaching a *different* worker is still refused and a dead worker's job is left to the reaper. Worker ids include the pid, so a restarted process does not inherit its predecessor's claims. Queue wait is measured only on a first claim — recording it again on a retry would fold the backoff delay into the metric and read as a capacity problem.

**Dispatch is now single-shot.** `POST /jobs/:id/trigger` read the job, checked `PENDING`, and published, with nothing holding the row still in between — so two clicks or a retried fetch both saw `PENDING` and both published. The second copy was harmless in the end, because claiming is status-guarded, but only after a worker had picked it up, asked the API for it, and been refused: real GPU scheduling spent on a message that could never succeed. Migration `0009` adds `dispatched_at`, and the publish now happens only for the caller whose `UPDATE ... WHERE dispatched_at IS NULL` returned a row. If the publish then fails, the claim is released — leaving it set would trade a rare double-dispatch for a routine dropped one. `messageId` on the published message is the job id, so the guarantee is visible broker-side too.

**`GET /api/jobs/logs` is paginated by keyset, not `OFFSET`.** It returned every job a tenant had ever run, on every dashboard load, unbounded — against a table the specification keeps forever. `OFFSET` would have made the database walk and discard every skipped row, so the last page of a long-lived tenant costs the most, and any job created mid-scroll shifts every later page by one, silently duplicating or skipping a row. Seeking on `(created_at, id)` is stable under insertion and reads only the page requested; migration `0009` adds the matching composite index so a page is a range scan whose cost does not grow with history. Cursors are opaque base64 so the sort key stays an implementation detail. Default 50, ceiling 200. The dashboard appends pages behind a "Load older jobs" button and returns to page one on refresh, so a job that changed state cannot appear twice.

`test:lifecycle` now covers all of it end to end: an unprocessable message is parked in tier one rather than dead-lettered, the same message arriving with its tiers spent *is* dead-lettered, a message left in a delay queue reappears on its work queue once the TTL elapses, `scheduleRetry` refuses to schedule past the last tier, two concurrent triggers yield exactly one 202 and one queued message, a worker re-claims its own job but a second worker is refused, and two pages of the audit log share no rows while a malformed cursor is rejected.

### Storage-driven dispatch (design item §2.4)

Dispatch was a step the browser performed: `request` → `PUT` → `trigger`. That made the client load-bearing for a state transition it has no business owning, and the two failure modes were real. Closing the tab between the upload and the trigger stranded a reserved credit — the reaper reclaims it now, but half an hour later, which is a patch and not a fix. Calling the trigger without uploading spent GPU scheduling on an image that did not exist.

**Completing the upload is now what queues the job.** There is no third call. The two states cannot diverge: no window in which an image exists with nothing scheduled to process it, and none in which a job is queued with no image to process.

This did **not** require replacing the local mock. The relevant property of an S3 event notification is that the *storage layer* reports completion, not the client — and the mock storage layer is the API itself, so it can say so directly. Both paths funnel into one `dispatchJob()`:

- **Real S3** posts its `ObjectCreated` notification to `POST /api/jobs/storage-events`, authenticated by `STORAGE_EVENT_SECRET`. It accepts the S3 `Records` envelope and a flat `{key}` for anything else pointed at a webhook. A 500 is returned on dispatch failure so S3 redelivers — the claim is released, so a later attempt still queues the job.
- **The mock** calls `dispatchJob()` from the upload handler's `finish` event.

A separate secret from the worker's, because they are different trust domains with different blast radii: the notifier can start work, the worker can settle it. Rotating one should not require rotating the other. Only raw-scan keys start a job — a mask written by a worker lands in the same bucket, and treating it as a trigger would make every completed job re-queue itself.

**Uploads are validated now.** §2.4 noted that a presigned PUT sets only `ContentType`, so the client picks both the body and the declared type. The size ceiling (`MAX_UPLOAD_BYTES`, 25 MB) is enforced as the bytes stream in rather than from `Content-Length`, which the client also chooses, and the first eight bytes must be the PNG signature — a GPU worker should never be the thing that discovers a scan is a zip file.

A rejected upload **settles the job rather than leaving it to the reaper**. The request has been answered, so nothing further is coming; holding the customer's credit for thirty minutes after an immediate rejection would be punitive. The job goes `FAILED` with the reason, the credit returns through the ledger, and an SSE event fires.

`POST /jobs/:id/trigger` remains as a fallback — for deployments that have not wired notifications yet, and for an operator re-queueing by hand. It is safe to call redundantly: `dispatched_at` means only one caller can ever win, so it now answers 400 for a job the upload already queued.

**Not addressed here:** per-tenant upload policies, and enforcing the ceiling on the real-S3 path. A presigned PUT cannot carry a size limit; a presigned POST policy with `content-length-range` can, which is the change a production deployment needs.

`test:flow` now asserts that the upload queues the job and that the old third call is refused; `test:lifecycle` covers a non-PNG body (415), a 26 MB body (413), both settling the job and returning the credit, an unauthenticated storage event (401), a valid S3-envelope event queueing to the right tier, and a mask key being ignored.

### Security controls (design item §2.6 — partly)

This item is different in kind from the others: several of its parts are procurement and infrastructure decisions rather than code, and implementing a convincing-looking version of them would be worse than leaving them absent. What follows is what was built, and then, in as much detail, what was not.

**Built.**

*An audit log that resists tampering.* `audit_events` is append-only and hash-chained: each row commits to its predecessor, so altering history invalidates every hash after it. Three mechanisms, because each stops a different attacker — revoked `UPDATE`/`DELETE` grants stop the application roles and anything reaching them through injection; a `BEFORE UPDATE OR DELETE` trigger stops the table owner and any superuser session, which grants and RLS do not constrain at all; and the chain detects an alteration made by someone who defeated both, such as anyone holding the disk or a backup. The first two prevent, the third detects, and only the third is something a regulator can check independently. `GET /api/audit/verify` exposes that check to the tenant's own administrator, which is the point — "you can verify it yourself" is what makes an audit log worth anything to the party it protects.

Recorded: sign-ins (success, failure, blocked, lockout), registration, invite creation, revocation, redemption and **every refusal with its reason**, domain-whitelist changes, organization switches, and every read of a scan. That last one is the question a hospital asks after an incident — who opened this patient's images — and it cannot be answered retrospectively if nobody was writing it down. Audit writes never fail a request: an audit outage that blocks a clinician from opening a scan converts a logging problem into a clinical one.

*Invites that are invitations rather than standing offers.* Links now carry `max_uses` (default 25) and expire by default at 30 days, both applied when an admin does not specify them — the safe value has to be the one you get by not thinking about it, and a link that never expires and never runs out is the shape of every invite-link incident. The cap is claimed transactionally at redemption and backed by a `CHECK` constraint, so a redemption path added later cannot exceed it. `memberships.invite_id` records which link admitted whom, so revoking a leaked invite can finally answer "and who did it let in?".

*Encryption at rest, per tenant.* Envelope encryption: each organization has its own AES-256 data key, stored only wrapped, and scans are AES-256-GCM encrypted before they touch the disk. Per-tenant rather than global for two reasons that matter contractually — containment, and deletion: destroying one tenant's wrapped key renders their scans unreadable immediately without touching anyone else's data and without waiting for a sweep, which is the only practical way to honour "delete our data" across object storage and backups. GCM authenticates, so a modified scan throws rather than returning plausible bytes to a radiologist. Scans are now served `no-store` rather than `private, max-age=300`; a scan left in a shared workstation's cache outlives the session that fetched it.

*Sign-in throttling.* Five consecutive failures lock an account for fifteen minutes, counted in the database rather than in process memory — per-instance counters divide an attacker's effort by the number of instances while appearing to work. The lockout applies to the correct password too; one that the real owner can bypass is a hint, not a lockout. Password rules are length-first (12 characters), because composition rules mostly produce `Password1!`.

**Not built, and why.**

*A KMS.* The master key is an environment variable, so it shares a blast radius with the process that reads it: a process compromise gets both halves. `src/crypto.ts` says so rather than implying parity. What the current design does buy is that the encryption boundary, the per-tenant key hierarchy, and the call sites are already right, so moving to `GenerateDataKey`/`Decrypt` changes two functions rather than the schema and every reader. It is deliberately **not** defaulted to a literal key: a deployment that forgot to set it would otherwise encrypt everything with a key published in this repository, which looks encrypted and is worse than honest plaintext.

*SSO/SAML and MFA.* Both need something this project does not have — an identity provider to federate with, and a second channel plus enrolment, recovery codes, and an account-recovery path that is not itself the weakest link. A TOTP implementation without those is a checkbox, and the recovery flow is where MFA deployments actually fail. This is the largest remaining gap and it should be next.

*DICOM de-identification.* The pipeline handles PNG. De-identification is not stripping a header field: it is burned-in pixel text, private tags, `StudyInstanceUID` consistency across a study, and a defensible policy about which of the ~4,000 attributes are retained. Doing it badly produces files that look de-identified and are not, which is the failure mode with actual patient consequences.

*BAA scope.* Contractual, and outside what code can settle.

*Per-tenant retention* was listed here and has since been built — see "Per-tenant retention" below.

*A prefix is still not a boundary.* §2.6 noted `org_id=` segregation is a naming convention unless IAM enforces it. RLS now enforces the database side, and per-tenant keys enforce the storage side cryptographically, which is stronger than an IAM policy. But the mock storage layer has no IAM at all — on real S3 the per-tenant IAM policies still need writing.

`npm run test:security` covers eleven behaviours, each written to fail if the control exists in name only: the audit log is altered *as the table owner, with the trigger disabled* to prove the chain still notices and names the row; the invite is genuinely exhausted and then a direct `UPDATE` past the cap is refused by the constraint; the stored scan is read off the disk and checked for the plaintext rather than trusted because a flag says so; and the mask a worker produced — the worker holds no data key and handles the bytes opaquely — is confirmed to decrypt at the far end.

### Retention of record (design item §2.7, the cascade)

The identity half of §2.7 was fixed by memberships in migration `0007`. Its second half was still live: every tenant-owned table hung off `organizations` with `ON DELETE CASCADE`, so a single `DELETE` erased that customer's jobs, their entire credit ledger, and the provenance of every mask ever produced for them. `arch.md` promises job metadata is "maintained indefinitely for auditing/billing"; a cascade contradicts that continuously, and does it quietly — the operator running the statement sees `DELETE 1`.

Migration `0011` inverts it. The relationships that carry the record — `jobs → organizations`, `jobs → users`, `credit_transactions → organizations`, `credit_transactions → jobs`, `organization_invites → organizations` — become `RESTRICT`, so the database refuses the delete instead of widening it. Being unable to delete the row *is* the requirement, not an obstacle to route around. Because every organization is created with a `TRIAL_GRANT` ledger row, this holds from the moment a tenant exists.

`memberships.invite_id` changed from `SET NULL` to `RESTRICT`, which is the subtler of the two fixes. Under `SET NULL`, deleting an invite did not break the attribution — it rewrote it. A dangling id is visibly broken; a `NULL` is indistinguishable from "this person joined without an invite", so the old behaviour silently converted "which link admitted this account" from a hard question into a wrong answer. Revoking a leaked link is `is_active = false`, which keeps the history.

Not everything is a record, and the deliberate exceptions are documented in the migration: `memberships` is current state, and who was a member when is already in `audit_events`, which holds no foreign keys at all and so is unreachable by any cascade; `job_events` is an SSE replay buffer pruned at seven days; `organization_invites.created_by` stays `SET NULL` because the creator's identity is preserved by `actor_email` on the `invite.created` audit row, which is denormalised for exactly this.

That leaves "remove this customer" needing a real answer, so closure is now a supported operation: `DELETE /api/auth/organization` (ORG_ADMIN, scoped by the token to their own tenant) sets `deleted_at`. A closed workspace stops appearing in `membershipsOf`, so no new token can name it; `switch-organization` re-checks it because that route takes an id from the request body; its invite links stop redeeming, including ones already in circulation; and it can no longer reserve credits or issue links, checked inside the reserving transaction so the workspace cannot close in the gap between check and write. Reads of existing rows still work, because an administrator exporting data during a wind-down is a legitimate use. Reopening is possible only from a session token minted before the closure — roughly a day — which covers closing the wrong workspace and noticing, and leaves anything later as an operator action, which is correct: reopening a workspace a customer asked to close is not self-service.

Users get the same treatment. `deleted_at` deactivates an account; the row survives because jobs reference it and those jobs are clinical records whose provenance is the account. Deactivation is checked *after* the password, not before — answering differently to an unauthenticated caller would turn the login endpoint into a directory of who used to work there.

Closure is explicitly **not** erasure, and the two should not be conflated. A tenant demanding their data be destroyed is served by destroying their per-organization data key (§2.6), which makes the stored images unreadable while leaving the metadata that billing and auditing are obliged to keep.

`npm run test:retention` covers eleven behaviours. The deletes are attempted **as the superuser**, the identity that ignores grants and RLS, because that is the threat — an operator at a `psql` prompt, not the application. Each is asserted to fail with `23503` specifically and to name its constraint, so a delete that fails for an unrelated reason cannot pass as protection; the surviving rows are then counted. Closure is exercised end to end, including that closing twice keeps the first timestamp (the time of closure is itself part of the record), that a closed workspace is refused at every write path, that a wrong password against a deactivated account still answers 401, and that the audit chain from §2.6 verifies across all of it.

### Per-tenant retention

`arch.md` §1 requires storage cleanup be "fully configurable". The sweeper built for fix #8 read one number from the environment, so every customer on a deployment got the same window — which is not configurable in the sense the requirement means. Retention is a term in a hospital contract, negotiated per customer, and a tenant who agreed to seven days is not served by a platform that keeps their images for thirty.

`organizations.retention_days` overrides `STORAGE_RETENTION_DAYS` per tenant (`PUT /api/auth/organization/retention`, ORG_ADMIN). NULL means the platform default rather than "keep forever": a tenant who has never stated a preference should track the deployment's policy and keep tracking it when that policy changes, which is why the default is not copied into the row. Zero is refused outright — it would read as "delete immediately" on the column and "retention disabled" on the environment variable, and those are opposites.

The sweep is now driven from the database instead of the filesystem: it asks which jobs have outlived *their own* tenant's window, rather than walking a directory comparing every mtime against one global number. That also corrects the clock. A file's mtime is a proxy for the age of a scan; the job's `created_at` is the age of the scan, and they diverge whenever a file is rewritten, restored from backup, or copied between hosts — a restore that silently extends a contractual retention window is the wrong direction to be wrong in. The interval is computed in SQL against `NOW()`, so both sides of the comparison come from one clock; mixing the database's `created_at` with the application's `new Date()` is exactly what made `job_queue_wait_seconds` silently record nothing earlier in this work.

`jobs.artifacts_purged_at` records that the images were removed, which is a different fact from the file being absent. Expired on schedule, never uploaded, and lost are three answers, only one of which is an incident, and a clinician asking why a scan will not open deserves the right one — so `GET /api/jobs/:id/image/:kind` answers `410` with the purge date rather than a bare `404`. The column is written only when the bytes are actually gone; recording a purge that did not happen would retire the job from the sweeper's working set while its images sat on disk past the window the tenant was promised, which is the one failure here a customer could hold against the contract.

Closed workspaces are deliberately not exempt: closure is not a reason to keep images longer, and it is precisely the case where nobody is watching.

`npm run test:retention` covers this in checks 11–14 — the bounds are probed (0, 4000, and 7.5 days all refused), two jobs of identical age in different tenants are aged in the database and swept, and only the seven-day tenant's scan is deleted while the one on the platform default survives. A second sweep is asserted to find nothing, the expired scan is asserted to answer 410 with its purge date, and the change of window is asserted to appear in the audit trail with the value it replaced.

**Status update.** All eight defect fixes have been applied, plus eight items from the design critique and part of a ninth — the credit ledger, job provenance, the SSE bus, the identity model, the operational surface, the queue topology's retry policy and idempotency, storage-driven dispatch, retention of record, per-tenant retention, and the implementable half of the security work. Ten suites cover the result: `test:flow`, `test:rls`, `test:lifecycle`, `test:credits`, `test:sse`, `test:identity`, `test:observability`, `test:security`, `test:retention`, and the ad-hoc verification described above. The backend compiles, starts, and passes `src/test-flow.ts` end to end — registration, domain whitelist enforcement, credit reservation, queue dispatch, GPU worker completion, and invite revocation all behave as specified, with the organization balance moving 3 → 2 on one successful job.

Additionally verified against the running stack: the SSE stream rejects an unauthenticated connection (401) and accepts a stream token, which is itself refused as a Bearer credential (403); a browser-side stream client receives both the `PROCESSING` and `SUCCESS` events the worker reports, confirming the notification path is genuinely restored; job images are served to their own tenant (200), refused anonymously (401), and refused across tenants (404); the worker report endpoint rejects a bad secret (401) and refuses a replayed report (409) without moving the balance.

Every remaining finding in this document stands as written and was verified against commit `9b53949`.

One further defect, found while re-verifying: **`src/test-flow.ts` was not idempotent.** It registered hardcoded email addresses, so a second run aborted at step 1 with `409 Email is already registered`. Now resolved — identities are stamped per run, and the suite passes twice in a row against a non-empty database.

Local infrastructure note: `docker-compose.override.yml` (gitignored) publishes the Postgres container on **5433**, because a locally installed PostgreSQL already occupies 5432 with different credentials. `DATABASE_URL` in `backend/.env` points there.
