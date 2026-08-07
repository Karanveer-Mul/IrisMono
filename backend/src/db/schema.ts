import { pgTable, uuid, varchar, integer, text, boolean, timestamp, pgEnum, doublePrecision, bigserial, jsonb } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// Custom enums
export const userRoleEnum = pgEnum("user_role", ["ORG_ADMIN", "MEMBER"]);
export const jobStatusEnum = pgEnum("job_status", ["PENDING", "PROCESSING", "SUCCESS", "FAILED"]);
export const infrastructureTierEnum = pgEnum("infrastructure_tier", ["STANDARD", "VIP"]);
export const creditReasonEnum = pgEnum("credit_reason", [
  "TRIAL_GRANT",
  "JOB_RESERVATION",
  "JOB_REFUND",
  "MANUAL_ADJUSTMENT",
  "BACKFILL",
]);

// 1. Organizations
export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  // Materialized total of credit_transactions, not the source of truth.
  // Defaults to 0: credits arrive as ledger entries so each has a recorded origin.
  creditBalance: integer("credit_balance").notNull().default(0),
  allowedDomains: text("allowed_domains").array().notNull().default(sql`'{}'::text[]`),
  // Which pool of GPU workers serves this tenant.
  infrastructureTier: infrastructureTierEnum("infrastructure_tier").notNull().default("STANDARD"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// 2. Users
//
// A user is a person, not a seat. Which organizations they belong to - and
// what they can do in each - lives in memberships.
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 255 }).unique().notNull(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  // Sign-in throttling. Held here rather than in process memory because the API
  // runs behind a load balancer - see src/passwords.ts.
  failedLoginCount: integer("failed_login_count").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// 2b. Memberships (user x organization x role)
//
// The role belongs to the relationship, so the same person can be ORG_ADMIN at
// one hospital and MEMBER at another.
export const memberships = pgTable("memberships", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  role: userRoleEnum("role").notNull().default("MEMBER"),
  // Which invite link admitted this person, when one did. Null for the founder
  // of a workspace and for memberships created before migration 0010.
  inviteId: uuid("invite_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// 3. Organization Invites
export const organizationInvites = pgTable("organization_invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  inviteCode: varchar("invite_code", { length: 100 }).unique().notNull(),
  allowedDomains: text("allowed_domains").array().notNull().default(sql`'{}'::text[]`),
  isActive: boolean("is_active").notNull().default(true),
  // Null means unlimited, which is the old behaviour and should be the
  // exception: an uncapped reusable link is a standing offer to anyone who
  // ever sees it. Enforced by a CHECK as well as by the handler.
  maxUses: integer("max_uses"),
  usesCount: integer("uses_count").notNull().default(0),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

// 4. Jobs
export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: jobStatusEnum("status").notNull().default("PENDING"),
  rawImageS3Key: varchar("raw_image_s3_key", { length: 512 }).notNull(),
  maskImageS3Key: varchar("mask_image_s3_key", { length: 512 }),
  errorMessage: text("error_message"),
  // Provenance. Which model produced this mask, on which worker, at what
  // compute cost. modelVersion is required on any SUCCESS - a mask whose
  // origin is unknown cannot be recalled if that model is later withdrawn.
  modelVersion: varchar("model_version", { length: 100 }),
  workerId: varchar("worker_id", { length: 100 }),
  gpuSeconds: doublePrecision("gpu_seconds"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Set when a worker claims the job. PROCESSING is aged from here, not from
  // created_at, so a long queue wait is not mistaken for a stalled worker.
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  // Set by the one caller whose trigger won. Makes dispatch single-shot: two
  // concurrent triggers cannot both publish the job. See migration 0009.
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
});

// 5. Credit ledger
//
// Append-only. organizations.credit_balance is a materialized total of these
// rows, not the source of truth - see migration 0004 and src/credits.ts.
export const creditTransactions = pgTable("credit_transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  // Null for grants and manual adjustments, which are not tied to a job.
  jobId: uuid("job_id").references(() => jobs.id, { onDelete: "cascade" }),
  // Negative reserves, positive returns. Never zero.
  delta: integer("delta").notNull(),
  reason: creditReasonEnum("reason").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// 6. Job event log
//
// Written before an event is fanned out to the API instances. The monotonic id
// is what a reconnecting client resumes from via Last-Event-ID.
export const jobEvents = pgTable("job_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  jobId: uuid("job_id"),
  eventType: varchar("event_type", { length: 64 }).notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// 7. Worker heartbeats
//
// Fleet liveness, not tenant data. The GPU tier holds no database credentials,
// so workers post heartbeats to the API and the API records them here - which
// makes the fleet visible from every API instance, not just the one that
// received the last beat. See migration 0008.
export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: varchar("worker_id", { length: 100 }).primaryKey(),
  modelVersion: varchar("model_version", { length: 100 }),
  queues: varchar("queues", { length: 255 }).notNull(),
  status: varchar("status", { length: 16 }).notNull(),
  currentJobId: uuid("current_job_id"),
  jobsProcessed: integer("jobs_processed").notNull().default(0),
  jobsFailed: integer("jobs_failed").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

// 8. Audit log
//
// Append-only and hash-chained. Immutability is enforced in the database
// (revoked grants plus a blocking trigger) and made verifiable by the chain -
// see migration 0010 and src/audit.ts. Never written through the ORM.
export const auditEvents = pgTable("audit_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  organizationId: uuid("organization_id"),
  actorUserId: uuid("actor_user_id"),
  actorEmail: varchar("actor_email", { length: 255 }),
  action: varchar("action", { length: 64 }).notNull(),
  target: varchar("target", { length: 255 }),
  metadata: jsonb("metadata").notNull(),
  ip: varchar("ip", { length: 64 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  previousHash: varchar("previous_hash", { length: 64 }),
  hash: varchar("hash", { length: 64 }).notNull(),
});

// Relations for ORM query building convenience
export const organizationsRelations = relations(organizations, ({ many }) => ({
  memberships: many(memberships),
  invites: many(organizationInvites),
  jobs: many(jobs),
  creditTransactions: many(creditTransactions),
}));

export const creditTransactionsRelations = relations(creditTransactions, ({ one }) => ({
  organization: one(organizations, {
    fields: [creditTransactions.organizationId],
    references: [organizations.id],
  }),
  job: one(jobs, {
    fields: [creditTransactions.jobId],
    references: [jobs.id],
  }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(memberships),
  jobs: many(jobs),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  user: one(users, {
    fields: [memberships.userId],
    references: [users.id],
  }),
  organization: one(organizations, {
    fields: [memberships.organizationId],
    references: [organizations.id],
  }),
}));

export const organizationInvitesRelations = relations(organizationInvites, ({ one }) => ({
  organization: one(organizations, {
    fields: [organizationInvites.organizationId],
    references: [organizations.id],
  }),
  creator: one(users, {
    fields: [organizationInvites.createdBy],
    references: [users.id],
  }),
}));

export const jobsRelations = relations(jobs, ({ one }) => ({
  organization: one(organizations, {
    fields: [jobs.organizationId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [jobs.userId],
    references: [users.id],
  }),
}));
