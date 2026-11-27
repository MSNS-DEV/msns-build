/**
 * Server-side records of signed-in devices plus "remember this device" cookies.
 * The JWT carries the AuthSession id (sid); revalidation checks it still exists.
 */
import type { PrincipalType } from "@prisma/client";
import { db } from "~/server/db";
import { hmac, randomToken, safeEqual, sha256 } from "./crypto";
import type { Principal } from "./principal";
import type { RequestMeta } from "./events";

export const TRUSTED_DEVICE_DAYS = 30;

export async function createAuthSession(input: {
  principal: Principal;
  meta: RequestMeta;
  mfaPending: boolean;
  method: string;
}) {
  return db.authSession.create({
    data: {
      principalId: input.principal.id,
      principalType: input.principal.type,
      ip: input.meta.ip,
      userAgent: input.meta.userAgent,
      mfaPending: input.mfaPending,
      mfaVerifiedAt: input.mfaPending ? null : new Date(),
      method: input.method,
    },
    select: { id: true },
  });
}

export async function revokeSessions(
  principal: Principal,
  options: { exceptId?: string } = {},
) {
  const result = await db.authSession.updateMany({
    where: {
      principalId: principal.id,
      revokedAt: null,
      ...(options.exceptId && { id: { not: options.exceptId } }),
    },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

export async function markSessionVerified(sessionId: string, method: string) {
  await db.authSession.update({
    where: { id: sessionId },
    data: { mfaPending: false, mfaVerifiedAt: new Date(), method },
  });
}

// ─── Trusted device cookie ───────────────────────────────────────────────

/** One cookie per account, so several people can share a device. */
export function trustedDeviceCookieName(principalId: string) {
  return `msns_td_${sha256(principalId).slice(0, 16)}`;
}

function trustPayload(
  principalId: string,
  tokenVersion: number,
  deviceTrustVersion: number,
  deviceId: string,
  exp: number,
) {
  return `${principalId}|${tokenVersion}|${deviceTrustVersion}|${deviceId}|${exp}`;
}

export function createTrustedDeviceCookie(
  principalId: string,
  tokenVersion: number,
  deviceTrustVersion: number,
) {
  const deviceId = randomToken(12);
  const exp = Math.floor(Date.now() / 1000) + TRUSTED_DEVICE_DAYS * 86400;
  const sig = hmac(
    trustPayload(principalId, tokenVersion, deviceTrustVersion, deviceId, exp),
  );
  return {
    name: trustedDeviceCookieName(principalId),
    value: `${deviceId}.${exp}.${sig}`,
    maxAge: TRUSTED_DEVICE_DAYS * 86400,
  };
}

export function verifyTrustedDeviceCookie(
  value: string | undefined,
  principalId: string,
  tokenVersion: number,
  deviceTrustVersion: number,
): boolean {
  if (!value) return false;
  const [deviceId, expRaw, sig] = value.split(".");
  const exp = Number(expRaw);
  if (!deviceId || !sig || !Number.isFinite(exp)) return false;
  if (exp < Math.floor(Date.now() / 1000)) return false;
  const expected = hmac(
    trustPayload(principalId, tokenVersion, deviceTrustVersion, deviceId, exp),
  );
  return safeEqual(sig, expected);
}

export function readCookie(
  cookieHeader: string | null | undefined,
  name: string,
): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export type SessionSummary = {
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
  ip: string | null;
  userAgent: string | null;
  method: string | null;
  principalType: PrincipalType;
};
