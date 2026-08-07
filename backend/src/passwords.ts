import { sql } from "drizzle-orm";
import { systemDb } from "./db";

/**
 * Sign-in throttling and password rules.
 *
 * There was neither: no strength requirement, no rate limit, no lockout, and no
 * record of failures - so an unlimited online guessing attack against a named
 * clinician's address was both free and invisible.
 */

/** Consecutive failures before the account is locked. */
const MAX_FAILED_LOGINS = Number(process.env.MAX_FAILED_LOGINS || 5);

/** How long a lockout lasts. */
const LOCKOUT_MINUTES = Number(process.env.LOGIN_LOCKOUT_MINUTES || 15);

const MIN_PASSWORD_LENGTH = Number(process.env.MIN_PASSWORD_LENGTH || 12);

/**
 * A short list of the passwords an attacker tries first.
 *
 * Not a substitute for a breach corpus - a real deployment should check against
 * Have I Been Pwned's k-anonymity API, which never sends the password. This
 * only stops the handful that composition rules famously fail to.
 */
const OBVIOUS_PASSWORDS = new Set([
  "password123",
  "administrator",
  "changeme1234",
  "welcome12345",
  "qwerty123456",
  "123456789012",
  "iloveyou1234",
  "hospital1234",
  "letmein12345",
]);

export interface PasswordCheck {
  ok: boolean;
  error?: string;
}

/**
 * Length first, character classes second.
 *
 * Composition rules ("one uppercase, one symbol") push people towards
 * `Password1!` and are worth little; length is what actually costs an attacker.
 * The classes here are a floor against the very shortest allowed passwords, not
 * the main defence.
 */
export function checkPasswordStrength(password: string, email?: string): PasswordCheck {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }

  if (password.length > 200) {
    // bcrypt truncates at 72 bytes anyway; the cap is to stop a megabyte of
    // input becoming a hashing cost the server pays.
    return { ok: false, error: "Password must be at most 200 characters" };
  }

  if (OBVIOUS_PASSWORDS.has(password.toLowerCase())) {
    return { ok: false, error: "Password is too common" };
  }

  if (email) {
    const localPart = email.split("@")[0]?.toLowerCase();
    if (localPart && localPart.length >= 3 && password.toLowerCase().includes(localPart)) {
      return { ok: false, error: "Password must not contain your email address" };
    }
  }

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((r) => r.test(password)).length;
  if (classes < 2) {
    return { ok: false, error: "Password must mix letters with digits or symbols" };
  }

  return { ok: true };
}

export interface FailureOutcome {
  failures: number;
  locked: boolean;
}

/**
 * Records a failed sign-in and locks the account once the threshold is hit.
 *
 * Counted in the database rather than in process memory: the API runs behind a
 * load balancer, and per-instance counters divide an attacker's effort by the
 * number of instances while looking like they work.
 */
export async function registerFailedLogin(userId: string): Promise<FailureOutcome> {
  const result = await systemDb.execute(sql`
    UPDATE users
       SET failed_login_count = failed_login_count + 1,
           locked_until = CASE
             WHEN failed_login_count + 1 >= ${MAX_FAILED_LOGINS}
             THEN NOW() + ${`${LOCKOUT_MINUTES} minutes`}::interval
             ELSE locked_until
           END
     WHERE id = ${userId}
    RETURNING failed_login_count, locked_until
  `);

  const row = result.rows[0] as any;
  const failures = Number(row?.failed_login_count ?? 0);

  return { failures, locked: failures >= MAX_FAILED_LOGINS };
}

/** Clears the counter after a successful sign-in. */
export async function clearFailedLogins(userId: string): Promise<void> {
  await systemDb.execute(sql`
    UPDATE users
       SET failed_login_count = 0, locked_until = NULL, last_login_at = NOW()
     WHERE id = ${userId}
  `);
}
