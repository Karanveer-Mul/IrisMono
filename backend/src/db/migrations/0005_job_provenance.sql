-- Job provenance.
--
-- The jobs table recorded what happened but not what produced it. For a
-- clinical or quasi-clinical product that is a hard gap: if a model version is
-- later found defective, you must be able to identify every mask it generated.
-- Retrofitting this leaves all existing masks unattributable, which is why it
-- is cheap now and impossible later.
--
-- gpu_seconds is recorded even though billing is currently flat at 1 credit per
-- image. A chest X-ray and a full CT volume differ by orders of magnitude in
-- compute, so the data has to exist before any metered pricing is possible.

ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "model_version" varchar(100);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "worker_id" varchar(100);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "gpu_seconds" double precision;
--> statement-breakpoint

-- The recall query: "which masks did model X produce?". Partial, because only
-- completed jobs carry a version.
CREATE INDEX IF NOT EXISTS "idx_jobs_model_version"
  ON "jobs" ("model_version")
  WHERE "model_version" IS NOT NULL;
