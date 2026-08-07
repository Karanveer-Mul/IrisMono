-- Credit ledger.
--
-- organizations.credit_balance was a mutable integer with no history: there was
-- no way to answer "why is this organization at 47 credits?", and refunds were
-- idempotent only by convention. For a billing system in a regulated domain
-- that is the wrong primitive.
--
-- Every movement is now an append-only row. The balance column survives as a
-- materialized total rather than the source of truth, because the reservation
-- path needs SELECT ... FOR UPDATE on a single row to serialize concurrent
-- spenders - summing the ledger under contention would need a heavier locking
-- strategy for no benefit. The two are kept in step inside one transaction and
-- can be reconciled at any time (see src/credits.ts).

DO $$ BEGIN
 CREATE TYPE "public"."credit_reason" AS ENUM (
   'TRIAL_GRANT',
   'JOB_RESERVATION',
   'JOB_REFUND',
   'MANUAL_ADJUSTMENT',
   'BACKFILL'
 );
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "credit_transactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  -- Null for grants and manual adjustments, which are not tied to a job.
  "job_id" uuid,
  -- Negative reserves, positive returns. Never zero.
  "delta" integer NOT NULL,
  "reason" "credit_reason" NOT NULL,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "credit_delta_non_zero" CHECK ("delta" <> 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_organization_id_fk"
   FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_job_id_fk"
   FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- The heart of it: at most one reservation and one refund per job. A replayed
-- worker report or an overlapping reaper sweep hits this constraint instead of
-- moving the balance a second time. Idempotency becomes structural rather than
-- something every call site has to remember.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_credit_tx_job_reason"
  ON "credit_transactions" ("job_id", "reason")
  WHERE "job_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_credit_tx_org_created"
  ON "credit_transactions" ("organization_id", "created_at" DESC);
--> statement-breakpoint

-- Seed the ledger so it agrees with the balances that already exist. Without
-- this every pre-existing organization would fail reconciliation forever.
INSERT INTO "credit_transactions" ("organization_id", "delta", "reason", "note")
SELECT id, credit_balance, 'BACKFILL', 'Opening balance at ledger introduction'
  FROM "organizations"
 WHERE credit_balance <> 0
   AND NOT EXISTS (
     SELECT 1 FROM "credit_transactions" ct WHERE ct.organization_id = organizations.id
   );
--> statement-breakpoint

-- The column defaulted to 3, which would have created credits with no ledger
-- entry behind them. New organizations now start empty and receive their trial
-- grant as a recorded transaction.
ALTER TABLE "organizations" ALTER COLUMN "credit_balance" SET DEFAULT 0;
--> statement-breakpoint

-- Same isolation posture as every other tenant table (migration 0002).
ALTER TABLE "credit_transactions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "credit_transactions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation_credit_transactions ON "credit_transactions";
--> statement-breakpoint
CREATE POLICY tenant_isolation_credit_transactions ON "credit_transactions"
  FOR ALL
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "credit_transactions" TO irismono_app, irismono_auth;
