-- Organization-wide MFA enforcement.
--
-- Enrolling a second factor was individual: a member could turn it on, and an
-- administrator could not require it. That is the version of MFA a hospital
-- does not buy - a control nobody has to use protects whoever was already
-- careful, which is not who the control is for.

ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "require_mfa" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- Default false, and no backfill, on purpose. Turning this on for an existing
-- tenant restricts every member who has not enrolled at their next sign-in;
-- doing that to a live workspace as a side effect of a migration is how a
-- morning of radiology gets held up by a deployment nobody announced. It is a
-- decision an administrator makes, and it is recorded when they make it.
