/**
 * Fixed-window counters stored in the LoginAttempt table, so limits hold
 * across serverless instances. Keys are namespaced (e.g. "otp-send:<id>").
 */
import { TRPCError } from "@trpc/server";
import { db } from "~/server/db";

export type LimitResult = { allowed: boolean; retryAfterSec: number };

/**
 * Count one hit against `key`. Denied once more than `limit` hits fall in the
 * current window; the key then stays blocked until the window ends.
 */
export async function hit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<LimitResult> {
  const now = new Date();
  const row = await db.loginAttempt.findUnique({ where: { key } });
  if (row?.lockedUntil && row.lockedUntil > now) {
    return {
      allowed: false,
      retryAfterSec: Math.ceil(
        (row.lockedUntil.getTime() - now.getTime()) / 1000,
      ),
    };
  }
  const expired = !row || now.getTime() - row.windowStart.getTime() > windowMs;
  const count = expired ? 1 : row.failures + 1;
  const windowStart = expired ? now : row.windowStart;
  const blocked = count > limit;
  const lockedUntil = blocked
    ? new Date(windowStart.getTime() + windowMs)
    : null;
  await db.loginAttempt.upsert({
    where: { key },
    create: { key, failures: 1, windowStart: now },
    update: { failures: count, windowStart, lockedUntil },
  });
  return {
    allowed: !blocked,
    retryAfterSec: blocked
      ? Math.ceil(((lockedUntil?.getTime() ?? 0) - now.getTime()) / 1000)
      : 0,
  };
}

/** Throws TOO_MANY_REQUESTS when the limit is exceeded. */
export async function enforce(
  key: string,
  limit: number,
  windowMs: number,
  message = "Too many attempts. Please wait and try again.",
) {
  const result = await hit(key, limit, windowMs);
  if (!result.allowed) {
    const minutes = Math.max(1, Math.ceil(result.retryAfterSec / 60));
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `${message} (try again in about ${minutes} min)`,
    });
  }
}

export async function reset(key: string) {
  await db.loginAttempt.deleteMany({ where: { key } });
}

/** Best-effort client IP from proxy headers (Vercel sets x-forwarded-for). */
export function ipFromHeaders(headers: Headers | undefined): string | null {
  const fwd = headers?.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() ?? headers?.get("x-real-ip") ?? null;
}

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
