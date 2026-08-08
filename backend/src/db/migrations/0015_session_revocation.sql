-- Sessions that can be ended.
--
-- A session token was valid for its full 24 hours no matter what happened
-- afterwards. Deactivating an account, closing a workspace, removing someone
-- from it, demoting an administrator, or turning on the MFA requirement all
-- took effect at the *next* sign-in - which is the one thing an attacker
-- holding a live token will not do.
--
-- "Revoke this person's access now" is a question a hospital asks on the day
-- someone leaves or a laptop goes missing, and the honest answer until now was
-- "within a day". Three cut-off timestamps make it "immediately", each at the
-- scope the person doing the revoking actually has:
--
--   users                 the person themselves, everywhere they act
--   memberships           one person in one workspace, which is an admin's reach
--   organizations         everyone in a workspace, for an incident
--
-- A token is refused when its `iat` is older than any cut-off that applies to
-- it. A timestamp rather than a counter because it answers "when", which the
-- audit trail needs anyway, and because it compares correctly against a claim
-- the token already carries - no new claim, so tokens issued before this
-- migration are covered by it too.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "sessions_invalid_before" timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "memberships" ADD COLUMN IF NOT EXISTS "sessions_invalid_before" timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "sessions_invalid_before" timestamp with time zone;
--> statement-breakpoint

-- NULL, not NOW(). Backfilling would sign out every live session on deploy,
-- which is a self-inflicted outage in a product where a session is someone in
-- the middle of reading a scan. Nothing is revoked until somebody revokes it.

-- Every authenticated request now reads the row that decides whether the session
-- still holds: the membership, its role, its cut-off, and both parents'. No new
-- index for it - uq_membership_user_org (migration 0007) is already a unique
-- btree on exactly (user_id, organization_id), which is the lookup.
