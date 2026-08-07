import { pgTable, uuid, varchar, integer, text, boolean, timestamp, pgEnum } from "drizzle-orm/pg-core";
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
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
  email: varchar("email", { length: 255 }).unique().notNull(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  role: userRoleEnum("role").notNull().default("MEMBER"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// 3. Organization Invites
export const organizationInvites = pgTable("organization_invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  inviteCode: varchar("invite_code", { length: 100 }).unique().notNull(),
  allowedDomains: text("allowed_domains").array().notNull().default(sql`'{}'::text[]`),
  isActive: boolean("is_active").notNull().default(true),
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Set when a worker claims the job. PROCESSING is aged from here, not from
  // created_at, so a long queue wait is not mistaken for a stalled worker.
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
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

// Relations for ORM query building convenience
export const organizationsRelations = relations(organizations, ({ many }) => ({
  users: many(users),
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

export const usersRelations = relations(users, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [users.organizationId],
    references: [organizations.id],
  }),
  jobs: many(jobs),
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
