/**
 * Small crypto helpers for account security: encryption of TOTP secrets,
 * hashing of one-time codes and tokens, HMAC signing and constant-time checks.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "crypto";

export class SecurityConfigError extends Error {}

function encryptionKey(): Buffer {
  const raw = process.env.TWO_FACTOR_ENCRYPTION_KEY;
  if (!raw || raw.length < 32) {
    throw new SecurityConfigError(
      "TWO_FACTOR_ENCRYPTION_KEY is not set (needs at least 32 characters). See docs/two-factor-setup.md.",
    );
  }
  // Accept any high-entropy string; derive a fixed 32-byte key from it.
  return createHash("sha256").update(raw, "utf8").digest();
}

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext> (base64url parts). */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ct.toString("base64url"),
  ].join(".");
}

export function decryptSecret(payload: string): string {
  const [version, iv, tag, ct] = payload.split(".");
  if (version !== "v1" || !iv || !tag || !ct) {
    throw new Error("Unrecognised encrypted secret format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ct, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/** SHA-256 hex. Used for one-time codes/tokens that are short-lived and rate limited. */
export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Hash for a one-time code, bound to the challenge so equal codes hash differently. */
export function hashCode(challengeId: string, code: string): string {
  return sha256(`${challengeId}:${code}`);
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still spend comparable time.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function signingKey(): string {
  const key = process.env.TRUSTED_DEVICE_SECRET ?? process.env.AUTH_SECRET;
  if (!key) {
    throw new SecurityConfigError(
      "AUTH_SECRET (or TRUSTED_DEVICE_SECRET) must be set to sign device cookies.",
    );
  }
  return key;
}

export function hmac(value: string): string {
  return createHmac("sha256", signingKey()).update(value).digest("base64url");
}

/** Numeric one-time code with a uniform distribution. */
export function randomDigits(length = 6): string {
  let out = "";
  for (let i = 0; i < length; i++) out += String(randomInt(0, 10));
  return out;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Readable temporary password: no look-alike characters. */
export function randomPassword(length = 12): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < length; i++)
    out += alphabet[randomInt(0, alphabet.length)];
  return out;
}

/** Backup code like "7KQ4-M9TX" (40 bits). */
export function randomBackupCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[randomInt(0, alphabet.length)];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

export function normaliseBackupCode(code: string): string {
  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}
