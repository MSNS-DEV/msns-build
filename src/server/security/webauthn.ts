/**
 * Passkeys (WebAuthn). Used three ways:
 *  - REGISTER: add a passkey from Profile → Security
 *  - STEP_UP:  as the second factor after a password sign-in
 *  - LOGIN:    passwordless sign-in from the sign-in page (discoverable credential)
 */
import { TRPCError } from "@trpc/server";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { WebAuthnPurpose } from "@prisma/client";
import { db } from "~/server/db";
import { randomToken, sha256 } from "./crypto";
import type { Principal } from "./principal";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const RP_NAME = "MSNS LMS";

/** RP ID and origin: env first, then AUTH_URL, then the request host. */
export function relyingParty(headers?: Headers) {
  const authUrl = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL;
  const host = headers?.get("x-forwarded-host") ?? headers?.get("host");
  const proto =
    headers?.get("x-forwarded-proto") ??
    (host?.startsWith("localhost") ? "http" : "https");
  const fallbackOrigin = authUrl
    ? new URL(authUrl).origin
    : host
      ? `${proto}://${host}`
      : "https://lms.msns.edu.pk";
  const origin = process.env.WEBAUTHN_ORIGIN ?? fallbackOrigin;
  const rpID = process.env.WEBAUTHN_RP_ID ?? new URL(origin).hostname;
  return { rpID, origin };
}

async function storeChallenge(
  challenge: string,
  purpose: WebAuthnPurpose,
  principal?: Principal,
) {
  // Opportunistic cleanup of old challenges.
  await db.webAuthnChallenge.deleteMany({
    where: { expiresAt: { lt: new Date(Date.now() - 60 * 60 * 1000) } },
  });
  return db.webAuthnChallenge.create({
    data: {
      challenge,
      purpose,
      principalId: principal?.id,
      principalType: principal?.type,
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    },
    select: { id: true },
  });
}

/** Single use: marks the challenge consumed and returns it. */
async function takeChallenge(
  id: string,
  purpose: WebAuthnPurpose,
  principal?: Principal,
) {
  const row = await db.webAuthnChallenge.findUnique({ where: { id } });
  const valid =
    row?.purpose === purpose &&
    !row.consumedAt &&
    row.expiresAt > new Date() &&
    (!principal || row.principalId === principal.id);
  if (!valid) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This passkey request expired. Please try again.",
    });
  }
  const consumed = await db.webAuthnChallenge.updateMany({
    where: { id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count !== 1) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Request already used.",
    });
  }
  return row;
}

// ─── Registration ────────────────────────────────────────────────────────

export async function registrationOptions(
  principal: Principal,
  userName: string,
  displayName: string,
  headers?: Headers,
) {
  const { rpID } = relyingParty(headers);
  const existing = await db.webAuthnCredential.findMany({
    where: { principalId: principal.id },
    select: { credentialId: true, transports: true },
  });
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName,
    userDisplayName: displayName,
    userID: new TextEncoder().encode(principal.id),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({
      id: c.credentialId,
      transports: c.transports,
    })),
    authenticatorSelection: {
      // Discoverable so the passkey also works for passwordless sign-in.
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });
  const { id } = await storeChallenge(options.challenge, "REGISTER", principal);
  return { challengeId: id, options };
}

export async function verifyRegistration(input: {
  principal: Principal;
  challengeId: string;
  response: RegistrationResponseJSON;
  name: string;
  headers?: Headers;
}) {
  const challenge = await takeChallenge(
    input.challengeId,
    "REGISTER",
    input.principal,
  );
  const { rpID, origin } = relyingParty(input.headers);
  const result = await verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: false,
  }).catch((error: unknown) => {
    console.error("Passkey registration failed", error);
    return null;
  });
  if (!result?.verified) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The passkey couldn't be verified.",
    });
  }
  const { credential, credentialDeviceType, credentialBackedUp } =
    result.registrationInfo;
  return db.webAuthnCredential.create({
    data: {
      principalId: input.principal.id,
      principalType: input.principal.type,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey),
      counter: BigInt(credential.counter),
      transports:
        credential.transports ?? input.response.response.transports ?? [],
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      name: input.name.trim().slice(0, 60) || "Passkey",
    },
    select: { id: true, name: true, createdAt: true },
  });
}

// ─── Authentication ──────────────────────────────────────────────────────

/** For STEP_UP: only this account's passkeys. For LOGIN: any discoverable one. */
export async function authenticationOptions(
  purpose: "STEP_UP" | "LOGIN",
  principal?: Principal,
  headers?: Headers,
) {
  const { rpID } = relyingParty(headers);
  const allowCredentials = principal
    ? (
        await db.webAuthnCredential.findMany({
          where: { principalId: principal.id },
          select: { credentialId: true, transports: true },
        })
      ).map((c) => ({ id: c.credentialId, transports: c.transports }))
    : [];
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials,
    // Passwordless sign-in must prove the user (biometric/PIN), not just presence.
    userVerification: purpose === "LOGIN" ? "required" : "preferred",
  });
  const { id } = await storeChallenge(options.challenge, purpose, principal);
  return { challengeId: id, options };
}

/**
 * Verifies an assertion. Returns the principal the passkey belongs to.
 * For STEP_UP the passkey must belong to `principal`.
 */
export async function verifyAuthentication(input: {
  purpose: "STEP_UP" | "LOGIN";
  challengeId: string;
  response: AuthenticationResponseJSON;
  principal?: Principal;
  headers?: Headers;
}): Promise<Principal> {
  const challenge = await takeChallenge(
    input.challengeId,
    input.purpose,
    input.principal,
  );
  const stored = await db.webAuthnCredential.findUnique({
    where: { credentialId: input.response.id },
  });
  const fail = () =>
    new TRPCError({ code: "UNAUTHORIZED", message: "Passkey not recognised." });
  if (!stored) throw fail();
  if (input.principal && stored.principalId !== input.principal.id)
    throw fail();

  const { rpID, origin } = relyingParty(input.headers);
  const result = await verifyAuthenticationResponse({
    response: input.response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: stored.credentialId,
      publicKey: new Uint8Array(stored.publicKey),
      counter: Number(stored.counter),
      transports: stored.transports,
    },
    requireUserVerification: input.purpose === "LOGIN",
  }).catch((error: unknown) => {
    console.error("Passkey authentication failed", error);
    return null;
  });
  if (!result?.verified) throw fail();

  await db.webAuthnCredential.update({
    where: { id: stored.id },
    data: {
      counter: BigInt(result.authenticationInfo.newCounter),
      lastUsedAt: new Date(),
    },
  });
  return { id: stored.principalId, type: stored.principalType };
}

/**
 * After a passwordless passkey check, hand out a one-time token that the
 * "passkey" NextAuth provider exchanges for a session.
 */
export async function issuePasskeyLoginToken(
  challengeId: string,
  principal: Principal,
) {
  const token = randomToken(32);
  await db.webAuthnChallenge.update({
    where: { id: challengeId },
    data: {
      loginTokenHash: sha256(token),
      principalId: principal.id,
      principalType: principal.type,
      // The token must be exchanged quickly.
      expiresAt: new Date(Date.now() + 2 * 60 * 1000),
    },
  });
  return token;
}

/** Exchange (single use) a passkey login token for its principal. */
export async function redeemPasskeyLoginToken(
  token: string,
): Promise<Principal | null> {
  const row = await db.webAuthnChallenge.findUnique({
    where: { loginTokenHash: sha256(token) },
  });
  if (
    !row?.principalId ||
    !row.principalType ||
    row.purpose !== "LOGIN" ||
    row.expiresAt < new Date()
  ) {
    return null;
  }
  // Clear the token so it can't be used twice.
  const cleared = await db.webAuthnChallenge.updateMany({
    where: { id: row.id, loginTokenHash: row.loginTokenHash },
    data: { loginTokenHash: null },
  });
  if (cleared.count !== 1) return null;
  return { id: row.principalId, type: row.principalType };
}
