/**
 * DB-backed brute-force throttling for the credentials login.
 * Stored in Postgres so it works across serverless instances.
 */
import { db } from "~/server/db";

const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
/** Failed attempts allowed per account within the window before locking it. */
const ACCOUNT_LIMIT = 5;
/** Failed attempts allowed per client IP within the window (password spraying). */
const IP_LIMIT = 30;

export const accountKey = (identifier: string) =>
  `acct:${identifier.trim().toLowerCase()}`;
export const ipKey = (ip: string) => `ip:${ip}`;

/** Best-effort client IP from proxy headers (Vercel sets x-forwarded-for). */
export function clientIp(request: Request | undefined): string | null {
  const fwd = request?.headers.get("x-forwarded-for");
  const ip = fwd?.split(",")[0]?.trim() ?? request?.headers.get("x-real-ip");
  return ip ?? null;
}

/** True if any of the keys is currently locked. */
export async function isLocked(keys: string[]): Promise<boolean> {
  const now = new Date();
  const locked = await db.loginAttempt.findFirst({
    where: { key: { in: keys }, lockedUntil: { gt: now } },
    select: { key: true },
  });
  return Boolean(locked);
}

async function recordFailure(key: string, limit: number) {
  const now = new Date();
  const row = await db.loginAttempt.findUnique({ where: { key } });
  const windowExpired =
    !row || now.getTime() - row.windowStart.getTime() > WINDOW_MS;
  const failures = windowExpired ? 1 : row.failures + 1;
  await db.loginAttempt.upsert({
    where: { key },
    create: { key, failures: 1, windowStart: now },
    update: {
      failures,
      ...(windowExpired && { windowStart: now }),
      ...(failures >= limit && {
        lockedUntil: new Date(now.getTime() + LOCK_MS),
      }),
    },
  });
}

export async function recordFailedLogin(identifier: string, ip: string | null) {
  await recordFailure(accountKey(identifier), ACCOUNT_LIMIT);
  if (ip) await recordFailure(ipKey(ip), IP_LIMIT);
}

export async function clearFailedLogins(identifier: string) {
  await db.loginAttempt.deleteMany({ where: { key: accountKey(identifier) } });
}
