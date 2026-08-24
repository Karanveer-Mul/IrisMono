import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "crypto";
import { sql } from "drizzle-orm";
import { systemDb } from "./db";
import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from "@aws-sdk/client-kms";

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
 * KMS. Set KMS_KEY_ID and the tenant data key is minted by KMS's own
 * GenerateDataKey and unwrapped by its Decrypt - both calls a real KMS logs
 * and permissions independently of this process, which an environment
 * variable cannot do. Unset, wrapping falls back to the local master key
 * exactly as before: nothing here requires KMS to run.
 *
 * The two are distinguished by a magic prefix on the stored wrapped_key, not
 * by a column - a wrapped_key with no prefix predates this and is read as the
 * local format it always was, so turning KMS_KEY_ID on does not require
 * touching a single existing row. New tenants after that point get
 * KMS-wrapped keys; existing tenants keep their local-wrapped ones until
 * whatever rotation process a real deployment runs.
 *
 * Scope is deliberately narrow: this wraps the per-tenant data key only. The
 * scan itself is still AES-256-GCM under that unwrapped key either way -
 * envelope encryption's whole point is that only the small key, not the
 * bulk data, ever touches the slower call. MFA secrets (sealWithMasterKey
 * below) stay on the local master key regardless of KMS_KEY_ID: they are
 * scoped to a person, not a tenant, and folding them into a per-tenant KMS
 * key would put a piece of one workspace's key hierarchy under an account
 * that also belongs to others. MASTER_KEY_BASE64 therefore stays required
 * in both modes.
 *
 * Untested against a live KMS here: nothing in this stack runs one. The
 * calls are the documented API shapes, and KMS_ENDPOINT exists so a
 * KMS-compatible emulator can stand in for it the way AWS_S3_ENDPOINT already
 * lets one stand in for storage - but until a real deployment or an emulator
 * points at it, this path is exercised no more than jobs.ts's non-mock S3
 * upload branch is: real code, correct against the documented API, dormant
 * in local dev.
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

const KMS_KEY_ID = process.env.KMS_KEY_ID || null;

/**
 * Marks a wrapped_key produced through KMS. Its absence means the local
 * master-key format - which is every row written before KMS_KEY_ID existed,
 * and every row written today when it is unset.
 */
const KMS_WRAP_MAGIC = Buffer.from("KMSWRAP1");

export function kmsConfigured(): boolean {
  return KMS_KEY_ID !== null;
}

let cachedKmsClient: KMSClient | null = null;

function kmsClient(): KMSClient {
  if (cachedKmsClient) return cachedKmsClient;
  cachedKmsClient = new KMSClient({
    region: process.env.AWS_REGION || "us-east-1",
    // A KMS-compatible emulator, the same role AWS_S3_ENDPOINT plays for
    // storage. Unset against real AWS.
    endpoint: process.env.KMS_ENDPOINT || undefined,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || "mock-key-id",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "mock-secret-key",
    },
  });
  return cachedKmsClient;
}

/**
 * Mints a fresh tenant data key and its wrapped form.
 *
 * KMS mode does not wrap a locally generated key - GenerateDataKey mints the
 * plaintext itself and returns the ciphertext blob alongside it, which is the
 * point of the call: the plaintext exists outside KMS only for as long as this
 * process holds it in memory. Local mode is unchanged from before this file
 * knew about KMS.
 */
async function generateWrappedTenantKey(): Promise<{ plaintext: Buffer; wrapped: Buffer }> {
  if (!KMS_KEY_ID) {
    const plaintext = randomBytes(KEY_BYTES);
    return { plaintext, wrapped: seal(masterKey(), plaintext) };
  }

  const result = await kmsClient().send(
    new GenerateDataKeyCommand({ KeyId: KMS_KEY_ID, KeySpec: "AES_256" })
  );
  if (!result.Plaintext || !result.CiphertextBlob) {
    throw new Error("KMS GenerateDataKey returned no key material");
  }
  return {
    plaintext: Buffer.from(result.Plaintext),
    wrapped: Buffer.concat([KMS_WRAP_MAGIC, Buffer.from(result.CiphertextBlob)]),
  };
}

/**
 * Unwraps a tenant data key, however it was wrapped.
 *
 * The prefix on the bytes decides the path, not the current value of
 * KMS_KEY_ID - a tenant wrapped under KMS before a key rotation must still
 * unwrap through KMS after one, and a tenant wrapped locally before KMS_KEY_ID
 * was ever set must still unwrap locally if it is unset again.
 */
async function unwrapTenantKey(wrapped: Buffer): Promise<Buffer> {
  if (wrapped.subarray(0, KMS_WRAP_MAGIC.length).equals(KMS_WRAP_MAGIC)) {
    const result = await kmsClient().send(
      new DecryptCommand({ CiphertextBlob: wrapped.subarray(KMS_WRAP_MAGIC.length) })
    );
    if (!result.Plaintext) {
      throw new Error("KMS Decrypt returned no key material");
    }
    return Buffer.from(result.Plaintext);
  }

  return open(masterKey(), wrapped);
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
    const key = await unwrapTenantKey(wrapped);
    keyCache.set(organizationId, key);
    return key;
  }

  const { plaintext, wrapped: wrappedBytes } = await generateWrappedTenantKey();
  const wrapped = wrappedBytes.toString("base64");

  // ON CONFLICT DO NOTHING, then re-read: two concurrent first uploads for a
  // new tenant must not end up with different keys, or one of the two scans
  // becomes permanently unreadable. In KMS mode this means the loser's
  // freshly-minted key is simply discarded unused - GenerateDataKey has no
  // side effect to undo.
  await systemDb.execute(sql`
    INSERT INTO organization_keys (organization_id, wrapped_key)
    VALUES (${organizationId}, ${wrapped})
    ON CONFLICT (organization_id) DO NOTHING
  `);

  const settled = await systemDb.execute(
    sql`SELECT wrapped_key FROM organization_keys WHERE organization_id = ${organizationId}`
  );
  const settledWrapped = (settled.rows[0] as any).wrapped_key as string;

  // The winner's key is already in hand; only the loser of the race above
  // needs to unwrap what actually got stored.
  const finalKey =
    settledWrapped === wrapped ? plaintext : await unwrapTenantKey(Buffer.from(settledWrapped, "base64"));
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

/**
 * Wrapping for secrets that belong to a person rather than to a tenant.
 *
 * A user's MFA secret cannot use a per-organization key: the same account can
 * belong to several organizations, and its second factor is a property of the
 * person, not of whichever workspace they happen to be acting in. So these go
 * under the master key directly, which is one level shallower than the scan
 * path - the same trade the tenant keys make, minus the containment.
 *
 * It is still worth doing. A database dump on its own then yields no usable
 * TOTP secrets, which is the realistic exposure: dumps travel, get restored
 * into staging, and end up in backups far more often than process memory does.
 */
export function sealWithMasterKey(plaintext: Buffer): string {
  return seal(masterKey(), plaintext).toString("base64");
}

export function openWithMasterKey(sealed: string): Buffer {
  return open(masterKey(), Buffer.from(sealed, "base64"));
}

/** Drops cached keys. Used by tests, and by key rotation. */
export function clearKeyCache() {
  keyCache.clear();
}
