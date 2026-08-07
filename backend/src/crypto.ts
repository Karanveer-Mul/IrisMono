import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "crypto";
import { sql } from "drizzle-orm";
import { systemDb } from "./db";

/**
 * Encryption at rest for stored scans.
 *
 * Envelope encryption: every organization has its own AES-256 data key, and
 * that key is stored only in wrapped form. Scans are encrypted with the
 * tenant's key, so possession of the image directory yields nothing without the
 * key that wraps them.
 *
 * Per-tenant rather than one global key, for two reasons that matter under a
 * hospital contract. Containment: compromising one tenant's key does not expose
 * another's. Deletion: destroying a tenant's wrapped key renders every scan of
 * theirs unreadable immediately, without touching anyone else's data and
 * without waiting for a sweep to finish - which is the only practical way to
 * honour "delete our data" over object storage and backups.
 *
 * WHAT THIS IS NOT. In deployment the wrapping belongs in a KMS: the data key
 * is produced by GenerateDataKey, the wrapped form is the KMS ciphertext blob,
 * and unwrapping is an API call that is itself logged and permissioned. Here
 * the master key is an environment variable, which means it sits in the same
 * blast radius as the application that reads it - a process compromise gets
 * both halves. That is a real difference in security, not an implementation
 * detail, and it is why this file names it rather than implying parity. What
 * this design does buy today is that the encryption boundary, the per-tenant
 * key hierarchy, and the call sites are already correct, so moving to KMS is a
 * change to two functions rather than to the schema and every reader.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Marks a file written by this module, so a plaintext file is recognisable. */
const MAGIC = Buffer.from("IRISENC1");

/**
 * Master key, from MASTER_KEY_BASE64.
 *
 * Deliberately not defaulted to a literal. A hardcoded fallback means a
 * deployment that forgot to set it still starts, encrypts everything with a key
 * published in the source tree, and looks encrypted - which is worse than
 * plaintext, because plaintext is at least honestly insecure.
 */
let cachedMasterKey: Buffer | null = null;

export class EncryptionNotConfigured extends Error {
  constructor() {
    super(
      "MASTER_KEY_BASE64 is not set or is not 32 bytes. Generate one with: " +
      "node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
    );
  }
}

export function encryptionConfigured(): boolean {
  const raw = process.env.MASTER_KEY_BASE64;
  if (!raw) return false;
  try {
    return Buffer.from(raw, "base64").length === KEY_BYTES;
  } catch {
    return false;
  }
}

function masterKey(): Buffer {
  if (cachedMasterKey) return cachedMasterKey;

  const raw = process.env.MASTER_KEY_BASE64;
  if (!raw) throw new EncryptionNotConfigured();

  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) throw new EncryptionNotConfigured();

  cachedMasterKey = key;
  return key;
}

/** AES-256-GCM, used both for wrapping keys and for encrypting scans. */
function seal(key: Buffer, plaintext: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function open(key: Buffer, sealed: Buffer): Buffer {
  const iv = sealed.subarray(0, IV_BYTES);
  const tag = sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = sealed.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  // GCM authenticates: a modified ciphertext throws here rather than returning
  // plausible-looking bytes, so a tampered scan cannot reach a radiologist.
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/**
 * The tenant's data key, unwrapped, creating it on first use.
 *
 * Cached per process because a scan fetch would otherwise pay a query and an
 * unwrap per image. In a KMS deployment this cache is what keeps the Decrypt
 * call count sane, and it should carry a TTL so a revoked key stops working
 * within a bounded time rather than at the next restart.
 */
const keyCache = new Map<string, Buffer>();

export async function dataKeyFor(organizationId: string): Promise<Buffer> {
  const cached = keyCache.get(organizationId);
  if (cached) return cached;

  const existing = await systemDb.execute(
    sql`SELECT wrapped_key FROM organization_keys WHERE organization_id = ${organizationId}`
  );

  if (existing.rows.length > 0) {
    const wrapped = Buffer.from((existing.rows[0] as any).wrapped_key, "base64");
    const key = open(masterKey(), wrapped);
    keyCache.set(organizationId, key);
    return key;
  }

  const key = randomBytes(KEY_BYTES);
  const wrapped = seal(masterKey(), key).toString("base64");

  // ON CONFLICT DO NOTHING, then re-read: two concurrent first uploads for a
  // new tenant must not end up with different keys, or one of the two scans
  // becomes permanently unreadable.
  await systemDb.execute(sql`
    INSERT INTO organization_keys (organization_id, wrapped_key)
    VALUES (${organizationId}, ${wrapped})
    ON CONFLICT (organization_id) DO NOTHING
  `);

  const settled = await systemDb.execute(
    sql`SELECT wrapped_key FROM organization_keys WHERE organization_id = ${organizationId}`
  );
  const finalKey = open(masterKey(), Buffer.from((settled.rows[0] as any).wrapped_key, "base64"));
  keyCache.set(organizationId, finalKey);
  return finalKey;
}

export async function encryptForOrganization(
  organizationId: string,
  plaintext: Buffer
): Promise<Buffer> {
  const key = await dataKeyFor(organizationId);
  return Buffer.concat([MAGIC, seal(key, plaintext)]);
}

export async function decryptForOrganization(
  organizationId: string,
  stored: Buffer
): Promise<Buffer> {
  if (!isEncrypted(stored)) {
    // Written before encryption was switched on. Returned as-is so existing
    // scans stay readable; a deployment that requires everything encrypted
    // should re-encrypt them rather than rely on this path.
    return stored;
  }

  const key = await dataKeyFor(organizationId);
  return open(key, stored.subarray(MAGIC.length));
}

export function isEncrypted(stored: Buffer): boolean {
  if (stored.length < MAGIC.length) return false;
  // Constant-time only for tidiness; this is a format marker, not a secret.
  return timingSafeEqual(stored.subarray(0, MAGIC.length), MAGIC);
}

/** Drops cached keys. Used by tests, and by key rotation. */
export function clearKeyCache() {
  keyCache.clear();
}
