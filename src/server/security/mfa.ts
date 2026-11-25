/**
 * Second-factor state and verification: TOTP, SMS/email one-time codes and
 * backup codes. Passkeys live in ./webauthn.ts.
 */
import { TRPCError } from "@trpc/server";
import * as OTPAuth from "otpauth";
import type { OtpChannel, OtpPurpose } from "@prisma/client";
import { db } from "~/server/db";
import { getSmsProvider, smsConfigured } from "~/server/sms";
import {
  decryptSecret,
  encryptSecret,
  hashCode,
  normaliseBackupCode,
  randomBackupCode,
  randomDigits,
  safeEqual,
  sha256,
} from "./crypto";
import { emailConfigured, sendCodeEmail } from "./mailer";
import type { Principal } from "./principal";
import { DAY, enforce, HOUR, MINUTE, reset } from "./rate-limit";

const ISSUER = "MSNS LMS";
const OTP_TTL_MS = 5 * MINUTE;
const OTP_MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;
const BACKUP_CODE_COUNT = 10;

// ─── State ────────────────────────────────────────────────────────────────

export type MfaMethods = {
  totp: boolean;
  sms: boolean;
  email: boolean;
  passkeys: number;
  backupCodes: number;
};

export async function getSecurityRow(principal: Principal) {
  return db.accountSecurity.findUnique({
    where: { principalId: principal.id },
  });
}

export async function ensureSecurityRow(principal: Principal) {
  return db.accountSecurity.upsert({
    where: { principalId: principal.id },
    create: { principalId: principal.id, principalType: principal.type },
    update: {},
  });
}

export async function getMethods(principal: Principal): Promise<MfaMethods> {
  const [sec, passkeys, backupCodes] = await Promise.all([
    getSecurityRow(principal),
    db.webAuthnCredential.count({ where: { principalId: principal.id } }),
    db.backupCode.count({
      where: { principalId: principal.id, usedAt: null },
    }),
  ]);
  return {
    totp: !!sec?.totpEnabledAt && !!sec.totpSecretEnc,
    sms: !!sec?.smsEnabled && !!sec.phoneVerifiedAt && !!sec.phone,
    email:
      !!sec?.emailOtpEnabled &&
      !!sec.contactEmailVerifiedAt &&
      !!sec.contactEmail,
    passkeys,
    backupCodes,
  };
}

/** Backup codes alone don't count: they're a recovery path for another factor. */
export function hasSecondFactor(m: MfaMethods): boolean {
  return m.totp || m.sms || m.email || m.passkeys > 0;
}

export async function roleRequires2fa(role: string): Promise<boolean> {
  const policy = await db.roleSecurityPolicy.findUnique({
    where: { role: role.toUpperCase() },
  });
  return !!policy?.require2fa;
}

/** Keep User.twoFactorAuth in step so lists can show 2FA status cheaply. */
export async function syncTwoFactorFlag(principal: Principal) {
  if (principal.type !== "USER") return;
  const enabled = hasSecondFactor(await getMethods(principal));
  await db.user.update({
    where: { id: principal.id },
    data: { twoFactorAuth: enabled },
  });
}

// ─── TOTP (authenticator apps) ───────────────────────────────────────────

function buildTotp(secretBase32: string, label: string) {
  return new OTPAuth.TOTP({
    issuer: ISSUER,
    label,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
}

/** Start enrolment: store a pending secret and return what the user scans. */
export async function beginTotp(principal: Principal, label: string) {
  const secret = new OTPAuth.Secret({ size: 20 });
  await db.accountSecurity.upsert({
    where: { principalId: principal.id },
    create: {
      principalId: principal.id,
      principalType: principal.type,
      totpPendingSecretEnc: encryptSecret(secret.base32),
    },
    update: { totpPendingSecretEnc: encryptSecret(secret.base32) },
  });
  const totp = buildTotp(secret.base32, label);
  return { secret: secret.base32, uri: totp.toString() };
}

function currentStep() {
  return Math.floor(Date.now() / 1000 / 30);
}

/** Returns the matched time step or null. Allows one step of clock drift. */
function matchTotp(secretBase32: string, code: string): number | null {
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const delta = buildTotp(secretBase32, "x").validate({
    token: clean,
    window: 1,
  });
  return delta === null ? null : currentStep() + delta;
}

export async function confirmTotp(principal: Principal, code: string) {
  const sec = await getSecurityRow(principal);
  if (!sec?.totpPendingSecretEnc) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Start authenticator setup again.",
    });
  }
  const secret = decryptSecret(sec.totpPendingSecretEnc);
  const step = matchTotp(secret, code);
  if (step === null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "That code didn't match. Check the time on your phone and try again.",
    });
  }
  await db.accountSecurity.update({
    where: { principalId: principal.id },
    data: {
      totpSecretEnc: sec.totpPendingSecretEnc,
      totpPendingSecretEnc: null,
      totpEnabledAt: new Date(),
      totpLastStep: step,
    },
  });
}

/** Verifies against the enabled secret and blocks replay of the same code. */
export async function verifyTotp(
  principal: Principal,
  code: string,
): Promise<boolean> {
  const sec = await getSecurityRow(principal);
  if (!sec?.totpSecretEnc || !sec.totpEnabledAt) return false;
  const step = matchTotp(decryptSecret(sec.totpSecretEnc), code);
  if (step === null) return false;
  if (sec.totpLastStep !== null && step <= sec.totpLastStep) return false;
  // Conditional update so two concurrent requests can't both use the code.
  const updated = await db.accountSecurity.updateMany({
    where: {
      principalId: principal.id,
      OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }],
    },
    data: { totpLastStep: step },
  });
  return updated.count === 1;
}

export async function disableTotp(principal: Principal) {
  await db.accountSecurity.updateMany({
    where: { principalId: principal.id },
    data: {
      totpSecretEnc: null,
      totpPendingSecretEnc: null,
      totpEnabledAt: null,
      totpLastStep: null,
    },
  });
}

// ─── One-time codes by SMS / email ───────────────────────────────────────

export function otpChannelsConfigured() {
  const devConsole =
    process.env.SMS_PROVIDER === "console" &&
    process.env.NODE_ENV !== "production";
  return { sms: smsConfigured(), email: emailConfigured() || devConsole };
}

function messageFor(purpose: OtpPurpose, code: string): string {
  const domain = process.env.WEBAUTHN_RP_ID ?? "lms.msns.edu.pk";
  const what =
    purpose === "LOGIN"
      ? "sign-in code"
      : purpose === "STEP_UP"
        ? "confirmation code"
        : "verification code";
  // The last line lets Android/Chrome offer the code automatically (WebOTP).
  return `MSNS LMS ${what}: ${code}\nValid for 5 minutes. Never share it.\n\n@${domain} #${code}`;
}

/**
 * Create and send a one-time code. Enforces a resend cooldown and hourly caps
 * per account, per IP and (for SMS) a daily cap that protects the SIM bundle.
 */
export async function issueOtp(input: {
  principal: Principal;
  purpose: OtpPurpose;
  channel: OtpChannel;
  destination: string;
  ip: string | null;
}) {
  const { principal, purpose, channel, destination, ip } = input;

  const last = await db.otpChallenge.findFirst({
    where: { principalId: principal.id, purpose },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (last && Date.now() - last.createdAt.getTime() < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil(
      (RESEND_COOLDOWN_MS - (Date.now() - last.createdAt.getTime())) / 1000,
    );
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `Please wait ${wait}s before requesting another code.`,
    });
  }

  await enforce(
    `otp-send:acct:${principal.id}`,
    5,
    HOUR,
    "Too many codes requested",
  );
  if (ip)
    await enforce(`otp-send:ip:${ip}`, 20, HOUR, "Too many codes requested");
  if (channel === "SMS") {
    const daily = Number(process.env.SMS_DAILY_LIMIT ?? 500);
    const day = new Date().toISOString().slice(0, 10);
    await enforce(
      `sms-daily:${day}`,
      daily,
      DAY,
      "The school's daily SMS limit has been reached. Use another method",
    );
  }

  const code = randomDigits(6);
  const challenge = await db.otpChallenge.create({
    data: {
      principalId: principal.id,
      principalType: principal.type,
      purpose,
      channel,
      destination,
      codeHash: "pending",
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
    },
  });
  await db.otpChallenge.update({
    where: { id: challenge.id },
    data: { codeHash: hashCode(challenge.id, code) },
  });

  try {
    if (channel === "SMS") {
      await getSmsProvider().send(destination, messageFor(purpose, code));
    } else {
      await sendCodeEmail(
        destination,
        "Your MSNS LMS code",
        messageFor(purpose, code),
      );
    }
  } catch (error) {
    await db.otpChallenge.delete({ where: { id: challenge.id } });
    console.error(`OTP delivery failed (${channel})`, error);
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        channel === "SMS"
          ? "We couldn't send the SMS right now. Try again shortly or use another method."
          : "We couldn't send the email right now. Try again shortly or use another method.",
    });
  }
  return { challengeId: challenge.id, expiresAt: challenge.expiresAt };
}

/**
 * Checks the latest unexpired code for this purpose. Returns the destination
 * it was sent to, or null when the code is wrong/expired/used up.
 */
export async function verifyOtp(
  principal: Principal,
  purpose: OtpPurpose,
  code: string,
): Promise<{ destination: string; channel: OtpChannel } | null> {
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const challenge = await db.otpChallenge.findFirst({
    where: {
      principalId: principal.id,
      purpose,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!challenge || challenge.attempts >= OTP_MAX_ATTEMPTS) return null;

  if (!safeEqual(challenge.codeHash, hashCode(challenge.id, clean))) {
    await db.otpChallenge.update({
      where: { id: challenge.id },
      data: { attempts: { increment: 1 } },
    });
    return null;
  }
  const consumed = await db.otpChallenge.updateMany({
    where: { id: challenge.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  return consumed.count === 1
    ? { destination: challenge.destination, channel: challenge.channel }
    : null;
}

// ─── Backup codes ────────────────────────────────────────────────────────

export async function regenerateBackupCodes(principal: Principal) {
  const codes = Array.from({ length: BACKUP_CODE_COUNT }, randomBackupCode);
  await db.$transaction([
    db.backupCode.deleteMany({ where: { principalId: principal.id } }),
    db.backupCode.createMany({
      data: codes.map((code) => ({
        principalId: principal.id,
        codeHash: sha256(`${principal.id}:${code}`),
      })),
    }),
  ]);
  return codes;
}

export async function redeemBackupCode(
  principal: Principal,
  code: string,
): Promise<boolean> {
  const normalised = normaliseBackupCode(code);
  const consumed = await db.backupCode.updateMany({
    where: {
      principalId: principal.id,
      usedAt: null,
      codeHash: sha256(`${principal.id}:${normalised}`),
    },
    data: { usedAt: new Date() },
  });
  return consumed.count === 1;
}

// ─── Brute-force guard shared by every second-factor check ─────────────

/** 10 wrong second-factor attempts per 15 minutes per account. */
export async function guardVerifyAttempt(principal: Principal) {
  await enforce(
    `mfa-verify:${principal.id}`,
    10,
    15 * MINUTE,
    "Too many incorrect codes",
  );
}

export async function clearVerifyAttempts(principal: Principal) {
  await reset(`mfa-verify:${principal.id}`);
}

/** Remove every second factor (admin reset or account recovery). */
export async function removeAllFactors(principal: Principal) {
  await db.$transaction([
    db.accountSecurity.updateMany({
      where: { principalId: principal.id },
      data: {
        totpSecretEnc: null,
        totpPendingSecretEnc: null,
        totpEnabledAt: null,
        totpLastStep: null,
        smsEnabled: false,
        emailOtpEnabled: false,
        deviceTrustVersion: { increment: 1 },
      },
    }),
    db.webAuthnCredential.deleteMany({ where: { principalId: principal.id } }),
    db.backupCode.deleteMany({ where: { principalId: principal.id } }),
  ]);
  await syncTwoFactorFlag(principal);
}
