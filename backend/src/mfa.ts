import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";

/**
 * Time-based one-time passwords (RFC 6238) and recovery codes.
 *
 * The audit called MFA the largest remaining gap in §2.6, with the caveat that
 * a TOTP implementation without enrolment and recovery is a checkbox. So this
 * file is deliberately not just the code generator: the parts that decide
 * whether MFA helps or merely annoys are the enrolment handshake (a secret is
 * not trusted until the user proves they can produce a code from it), replay
 * refusal, and recovery codes that work exactly once.
 *
 * TOTP needs no third party - the second channel is the authenticator app the
 * user already has, and the shared secret never leaves this deployment. What
 * still cannot be built here is the last-resort path: a user who loses both
 * their phone and their recovery codes needs a human process to get back in,
 * and that process is where MFA deployments are actually broken. This is
 * stated in the README rather than papered over with an email reset, which
 * would reduce the second factor to the strength of a mailbox.
 */

/** RFC 6238 defaults. Every authenticator app assumes these. */
const STEP_SECONDS = 30;
const DIGITS = 6;
const SECRET_BYTES = 20;

/**
 * How far either side of now a code is accepted.
 *
 * One step, so a code stays valid for at most 90 seconds across the window.
 * Wider tolerates worse clocks at the cost of extending every code's life,
 * including one read over someone's shoulder. One step is what the RFC suggests
 * and what phones need in practice, since they sync time from the network.
 */
const DRIFT_STEPS = 1;

const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 10;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, unpadded - the encoding otpauth:// URIs use. */
export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

export function base32Decode(encoded: string): Buffer {
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (const character of encoded.toUpperCase().replace(/=+$/, "")) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) throw new Error("Invalid base32 character in secret");

    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(output);
}

/** A fresh 160-bit secret, base32 encoded for the authenticator app. */
export function generateSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/**
 * The URI an authenticator app reads from a QR code.
 *
 * The issuer appears twice - as a label prefix and as a parameter - because
 * older apps read one and newer ones read the other, and an account that shows
 * up as a bare email address among thirty others is one a user deletes by
 * accident.
 */
export function otpauthUri(secret: string, email: string, issuer = "IrisMono"): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** The counter value for a moment in time. */
export function stepAt(when: Date = new Date()): number {
  return Math.floor(when.getTime() / 1000 / STEP_SECONDS);
}

/**
 * HOTP (RFC 4226) at a given counter.
 *
 * SHA-1 is not a choice: every authenticator app implements TOTP over
 * HMAC-SHA1, and HMAC does not inherit SHA-1's collision weakness. Changing it
 * would break every phone rather than improve anything.
 */
function code(secret: string, counter: number): string {
  const key = base32Decode(secret);

  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac("sha1", key).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const truncated =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];

  return String(truncated % 10 ** DIGITS).padStart(DIGITS, "0");
}

export interface CodeCheck {
  ok: boolean;
  /** The step the code belongs to. Stored so it cannot be replayed. */
  step: number | null;
}

/**
 * Checks a code against the drift window.
 *
 * Returns which step matched, because accepting a code is only half the job:
 * a TOTP code is valid for a whole step, so without recording the step that was
 * used, anyone who observes a code - over a shoulder, in a screen share, in a
 * proxy log - can replay it for the rest of that window. The caller must refuse
 * a step it has already seen.
 */
export function checkCode(secret: string, presented: string, when: Date = new Date()): CodeCheck {
  const cleaned = presented.replace(/\s+/g, "");
  if (!/^[0-9]{6}$/.test(cleaned)) return { ok: false, step: null };

  const current = stepAt(when);

  for (let offset = -DRIFT_STEPS; offset <= DRIFT_STEPS; offset++) {
    const step = current + offset;
    const expected = code(secret, step);
    // Constant-time: a comparison that returns early leaks how many leading
    // digits were right, and six digits is a small enough space to walk.
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(cleaned))) {
      return { ok: true, step };
    }
  }

  return { ok: false, step: null };
}

/**
 * Ten single-use recovery codes and their hashes.
 *
 * Hashed with SHA-256 rather than bcrypt, deliberately. bcrypt's cost exists to
 * slow the guessing of low-entropy secrets that people choose; these are 80
 * random bits that this system chose, so there is nothing to slow down. Running
 * ten bcrypt comparisons per failed sign-in attempt would instead hand an
 * attacker a CPU amplifier pointed at the login endpoint.
 */
export function generateRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const codes: string[] = [];
  const hashes: string[] = [];

  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    // Grouped for transcription: these get written down, and a 20-character
    // run with no break in it is copied wrong often enough to matter.
    const raw = randomBytes(RECOVERY_CODE_BYTES).toString("hex");
    const formatted = `${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15)}`;
    codes.push(formatted);
    hashes.push(hashRecoveryCode(formatted));
  }

  return { codes, hashes };
}

export function hashRecoveryCode(presented: string): string {
  // Normalised before hashing: a code read off paper arrives with stray spaces,
  // inconsistent case, and sometimes without its separators.
  const normalised = presented.trim().toLowerCase().replace(/[^0-9a-f]/g, "");
  return createHash("sha256").update(normalised).digest("hex");
}
