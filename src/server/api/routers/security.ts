/**
 * Self-service account security for every role: password, two-factor methods
 * (authenticator app, SMS, email, passkeys, backup codes), signed-in devices
 * and recent activity. Also the second step of sign-in.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { compare, hash } from "bcryptjs";
import { cookies } from "next/headers";
import QRCode from "qrcode";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  createTRPCRouter,
  pendingSessionProcedure,
  protectedProcedure,
  publicProcedure,
} from "~/server/api/trpc";
import { db } from "~/server/db";
import {
  maskEmail,
  maskPhone,
  normaliseEmail,
  normalisePhone,
} from "~/server/security/contact";
import { SecurityConfigError } from "~/server/security/crypto";
import {
  logSecurityEvent,
  metaFromHeaders,
  type RequestMeta,
} from "~/server/security/events";
import {
  beginTotp,
  clearVerifyAttempts,
  confirmTotp,
  disableTotp,
  ensureSecurityRow,
  getMethods,
  getSecurityRow,
  guardVerifyAttempt,
  hasSecondFactor,
  issueOtp,
  otpChannelsConfigured,
  regenerateBackupCodes,
  roleRequires2fa,
  syncTwoFactorFlag,
  redeemBackupCode,
  verifyOtp,
  verifyTotp,
} from "~/server/security/mfa";
import {
  bumpTokenVersion,
  loadAccount,
  principalFromSession,
  type Principal,
  type PrincipalAccount,
} from "~/server/security/principal";
import { enforce, ipFromHeaders, MINUTE } from "~/server/security/rate-limit";
import {
  createTrustedDeviceCookie,
  markSessionVerified,
  revokeSessions,
} from "~/server/security/sessions";
import {
  authenticationOptions,
  issuePasskeyLoginToken,
  registrationOptions,
  verifyAuthentication,
  verifyRegistration,
} from "~/server/security/webauthn";

const codeSchema = z.string().trim().min(6).max(12);
const passwordSchema = z.string().min(1).max(200);
const newPasswordSchema = z
  .string()
  .min(8, "Use at least 8 characters")
  .max(100)
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), {
    message: "Use both letters and numbers",
  });
const registrationResponse = z.custom<RegistrationResponseJSON>(
  (v) => typeof v === "object" && v !== null && "id" in v,
);
const authenticationResponse = z.custom<AuthenticationResponseJSON>(
  (v) => typeof v === "object" && v !== null && "id" in v,
);

type Ctx = {
  session: { user: { id: string; accountType: string }; sessionId?: string };
  headers: Headers;
};

function wrapConfigErrors<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((error: unknown) => {
    if (error instanceof SecurityConfigError) {
      console.error(error.message);
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "This sign-in method isn't configured on the server yet. Please contact the school office.",
      });
    }
    throw error;
  });
}

async function accountFor(ctx: Ctx): Promise<PrincipalAccount> {
  const account = await loadAccount(principalFromSession(ctx.session.user));
  if (!account) throw new TRPCError({ code: "UNAUTHORIZED" });
  return account;
}

const metaOf = (ctx: Ctx): RequestMeta => metaFromHeaders(ctx.headers);

/** Re-check the password before a sensitive change. */
async function reauthenticate(account: PrincipalAccount, password: string) {
  await guardVerifyAttempt(account);
  if (!(await compare(password, account.passwordHash))) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Your password is incorrect.",
    });
  }
}

/** Issue backup codes the first time any second factor is enabled. */
async function initialBackupCodes(principal: Principal) {
  const remaining = await db.backupCode.count({
    where: { principalId: principal.id, usedAt: null },
  });
  return remaining === 0 ? regenerateBackupCodes(principal) : undefined;
}

/** Refuse to remove the last factor when the role requires 2FA. */
async function assertCanRemoveFactor(
  account: PrincipalAccount,
  remaining: (m: Awaited<ReturnType<typeof getMethods>>) => boolean,
) {
  if (!(await roleRequires2fa(account.role))) return;
  if (!remaining(await getMethods(account))) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Your role requires two-factor authentication. Add another method before removing this one.",
    });
  }
}

async function setTrustedDeviceCookie(account: PrincipalAccount) {
  const sec = await ensureSecurityRow(account);
  const cookie = createTrustedDeviceCookie(
    account.id,
    account.tokenVersion,
    sec.deviceTrustVersion,
  );
  try {
    (await cookies()).set(cookie.name, cookie.value, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: cookie.maxAge,
    });
  } catch {
    // Not in a request that can set cookies (e.g. server-side caller).
  }
}

async function completeSecondFactor(
  ctx: Ctx,
  account: PrincipalAccount,
  method: string,
  remember: boolean,
) {
  if (!ctx.session.sessionId) throw new TRPCError({ code: "UNAUTHORIZED" });
  await markSessionVerified(ctx.session.sessionId, `password+${method}`);
  await clearVerifyAttempts(account);
  if (remember) await setTrustedDeviceCookie(account);
  await logSecurityEvent(account, "login.success", metaOf(ctx), {
    secondFactor: method,
    rememberedDevice: remember,
  });
}

export const securityRouter = createTRPCRouter({
  // ─── Second step of sign-in ──────────────────────────────────────────

  loginChallenge: pendingSessionProcedure.query(async ({ ctx }) => {
    if (!ctx.session.user.twoFactorPending) return { pending: false as const };
    const account = await accountFor(ctx);
    const [methods, sec] = await Promise.all([
      getMethods(account),
      getSecurityRow(account),
    ]);
    return {
      pending: true as const,
      displayName: account.displayName,
      methods: {
        totp: methods.totp,
        sms: methods.sms ? maskPhone(sec?.phone) : null,
        email: methods.email ? maskEmail(sec?.contactEmail) : null,
        passkey: methods.passkeys > 0,
        backupCode: methods.backupCodes > 0,
      },
    };
  }),

  sendLoginCode: pendingSessionProcedure
    .input(z.object({ channel: z.enum(["SMS", "EMAIL"]) }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.session.user.twoFactorPending) return { sent: false };
      const account = await accountFor(ctx);
      const [methods, sec] = await Promise.all([
        getMethods(account),
        getSecurityRow(account),
      ]);
      const destination =
        input.channel === "SMS"
          ? methods.sms && sec?.phone
          : methods.email && sec?.contactEmail;
      if (!destination) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "That method isn't set up for this account.",
        });
      }
      await wrapConfigErrors(() =>
        issueOtp({
          principal: account,
          purpose: "LOGIN",
          channel: input.channel,
          destination,
          ip: ipFromHeaders(ctx.headers),
        }),
      );
      await logSecurityEvent(account, "mfa.code_sent", metaOf(ctx), {
        channel: input.channel,
      });
      return { sent: true };
    }),

  verifyLogin: pendingSessionProcedure
    .input(
      z.object({
        method: z.enum(["totp", "sms", "email", "backup"]),
        code: codeSchema,
        remember: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.session.user.twoFactorPending) return { ok: true };
      const account = await accountFor(ctx);
      await guardVerifyAttempt(account);

      let ok = false;
      if (input.method === "totp") {
        ok = await wrapConfigErrors(() => verifyTotp(account, input.code));
      } else if (input.method === "backup") {
        ok = await redeemBackupCode(account, input.code);
      } else {
        const result = await verifyOtp(account, "LOGIN", input.code);
        ok = result?.channel === (input.method === "sms" ? "SMS" : "EMAIL");
      }

      if (!ok) {
        await logSecurityEvent(account, "mfa.failed", metaOf(ctx), {
          method: input.method,
        });
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "That code isn't valid. Check it and try again.",
        });
      }
      await completeSecondFactor(ctx, account, input.method, input.remember);
      if (input.method === "backup") {
        const left = await db.backupCode.count({
          where: { principalId: account.id, usedAt: null },
        });
        await logSecurityEvent(account, "mfa.backup_code_used", metaOf(ctx), {
          remaining: left,
        });
        return { ok: true, backupCodesLeft: left };
      }
      return { ok: true };
    }),

  passkeyStepUpOptions: pendingSessionProcedure.mutation(async ({ ctx }) => {
    const account = await accountFor(ctx);
    await enforce(`passkey-opts:${account.id}`, 20, 15 * MINUTE);
    return authenticationOptions("STEP_UP", account, ctx.headers);
  }),

  passkeyStepUpVerify: pendingSessionProcedure
    .input(
      z.object({
        challengeId: z.string(),
        response: authenticationResponse,
        remember: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.session.user.twoFactorPending) return { ok: true };
      const account = await accountFor(ctx);
      await guardVerifyAttempt(account);
      await verifyAuthentication({
        purpose: "STEP_UP",
        challengeId: input.challengeId,
        response: input.response,
        principal: account,
        headers: ctx.headers,
      });
      await completeSecondFactor(ctx, account, "passkey", input.remember);
      return { ok: true };
    }),

  // ─── Passwordless sign-in with a passkey (sign-in page) ───────────────

  passkeyLoginOptions: publicProcedure.mutation(async ({ ctx }) => {
    const ip = ipFromHeaders(ctx.headers) ?? "unknown";
    await enforce(`passkey-login:ip:${ip}`, 30, 15 * MINUTE);
    return authenticationOptions("LOGIN", undefined, ctx.headers);
  }),

  passkeyLoginVerify: publicProcedure
    .input(
      z.object({ challengeId: z.string(), response: authenticationResponse }),
    )
    .mutation(async ({ ctx, input }) => {
      const ip = ipFromHeaders(ctx.headers) ?? "unknown";
      await enforce(`passkey-login:ip:${ip}`, 30, 15 * MINUTE);
      const principal = await verifyAuthentication({
        purpose: "LOGIN",
        challengeId: input.challengeId,
        response: input.response,
        headers: ctx.headers,
      });
      const token = await issuePasskeyLoginToken(input.challengeId, principal);
      return { token };
    }),

  // ─── Overview for Profile → Security ─────────────────────────────────

  overview: protectedProcedure.query(async ({ ctx }) => {
    const account = await accountFor(ctx);
    const [methods, sec, passkeys, sessions, events, policy] =
      await Promise.all([
        getMethods(account),
        getSecurityRow(account),
        db.webAuthnCredential.findMany({
          where: { principalId: account.id },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            name: true,
            createdAt: true,
            lastUsedAt: true,
            deviceType: true,
            backedUp: true,
          },
        }),
        db.authSession.findMany({
          where: { principalId: account.id, revokedAt: null },
          orderBy: { lastSeenAt: "desc" },
          take: 20,
          select: {
            id: true,
            createdAt: true,
            lastSeenAt: true,
            ip: true,
            userAgent: true,
            method: true,
            mfaPending: true,
          },
        }),
        db.securityEvent.findMany({
          where: { principalId: account.id },
          orderBy: { createdAt: "desc" },
          take: 25,
          select: {
            id: true,
            type: true,
            createdAt: true,
            ip: true,
            userAgent: true,
          },
        }),
        roleRequires2fa(account.role),
      ]);
    const channels = otpChannelsConfigured();
    return {
      account: {
        displayName: account.displayName,
        loginId: account.loginId,
        role: account.role,
        isParent: account.type === "PARENT",
        mustChangePassword: account.mustChangePassword,
      },
      policyRequires2fa: policy,
      has2fa: hasSecondFactor(methods),
      methods,
      channels,
      totp: { enabled: methods.totp, enabledAt: sec?.totpEnabledAt ?? null },
      sms: {
        phone: maskPhone(sec?.phone),
        verified: !!sec?.phoneVerifiedAt,
        enabled: methods.sms,
        numberOnFile: maskPhone(
          account.suggestedPhone
            ? normalisePhone(account.suggestedPhone)
            : null,
        ),
      },
      email: {
        address: sec?.contactEmail ?? null,
        verified: !!sec?.contactEmailVerifiedAt,
        enabled: methods.email,
      },
      passkeys,
      backupCodesRemaining: methods.backupCodes,
      sessions: sessions.map((s) => ({
        ...s,
        current: s.id === ctx.session.sessionId,
      })),
      events,
    };
  }),

  // ─── Password ────────────────────────────────────────────────────────

  changePassword: protectedProcedure
    .input(
      z.object({
        currentPassword: passwordSchema,
        newPassword: newPasswordSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const account = await accountFor(ctx);
      await reauthenticate(account, input.currentPassword);
      if (input.currentPassword === input.newPassword) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Choose a password different from the current one.",
        });
      }
      if (
        input.newPassword.toLowerCase() === account.accountId.toLowerCase() ||
        input.newPassword.toLowerCase() === account.loginId.toLowerCase()
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Don't use your ID or email as your password.",
        });
      }
      const passwordHash = await hash(input.newPassword, 12);
      if (account.type === "PARENT") {
        await db.parentGuardian.update({
          where: { guardentId: account.id },
          data: { passwordHash, mustChangePassword: false },
        });
      } else {
        await db.user.update({
          where: { id: account.id },
          data: { password: passwordHash, mustChangePassword: false },
        });
      }
      // Other devices must sign in again; remembered devices are forgotten.
      const signedOut = await revokeSessions(account, {
        exceptId: ctx.session.sessionId,
      });
      await db.accountSecurity.updateMany({
        where: { principalId: account.id },
        data: { deviceTrustVersion: { increment: 1 } },
      });
      await logSecurityEvent(account, "password.changed", metaOf(ctx));
      return { ok: true, otherSessionsSignedOut: signedOut };
    }),

  // ─── Authenticator app (TOTP) ────────────────────────────────────────

  totpBegin: protectedProcedure.mutation(async ({ ctx }) => {
    const account = await accountFor(ctx);
    const { secret, uri } = await wrapConfigErrors(() =>
      beginTotp(account, account.loginId),
    );
    const qrDataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 240 });
    return { secret, uri, qrDataUrl };
  }),

  totpEnable: protectedProcedure
    .input(z.object({ code: codeSchema }))
    .mutation(async ({ ctx, input }) => {
      const account = await accountFor(ctx);
      await guardVerifyAttempt(account);
      await wrapConfigErrors(() => confirmTotp(account, input.code));
      await syncTwoFactorFlag(account);
      const backupCodes = await initialBackupCodes(account);
      await logSecurityEvent(account, "mfa.totp_enabled", metaOf(ctx));
      return { ok: true, backupCodes };
    }),

  totpDisable: protectedProcedure
    .input(z.object({ password: passwordSchema }))
    .mutation(async ({ ctx, input }) => {
      const account = await accountFor(ctx);
      await reauthenticate(account, input.password);
      await assertCanRemoveFactor(
        account,
        (m) => m.sms || m.email || m.passkeys > 0,
      );
      await disableTotp(account);
      await syncTwoFactorFlag(account);
      await logSecurityEvent(account, "mfa.totp_disabled", metaOf(ctx));
      return { ok: true };
    }),

  // ─── SMS ─────────────────────────────────────────────────────────────

  phoneStart: protectedProcedure
    .input(
      z.object({
        phone: z.string().max(30).optional(),
        useNumberOnFile: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const account = await accountFor(ctx);
      const raw = input.useNumberOnFile ? account.suggestedPhone : input.phone;
      const phone = raw ? normalisePhone(raw) : null;
      if (!phone) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Enter a valid mobile number, e.g. 0300 1234567.",
        });
      }
      await wrapConfigErrors(() =>
        issueOtp({
          principal: account,
          purpose: "VERIFY_PHONE",
          channel: "SMS",
          destination: phone,
          ip: ipFromHeaders(ctx.headers),
        }),
      );
      return { sentTo: maskPhone(phone) };
    }),

  phoneVerify: protectedProcedure
    .input(z.object({ code: codeSchema }))
    .mutation(async ({ ctx, input }) => {
      const account = await accountFor(ctx);
      await guardVerifyAttempt(account);
      const result = await verifyOtp(account, "VERIFY_PHONE", input.code);
      if (!result) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "That code isn't valid or has expired.",
        });
      }
      await db.accountSecurity.upsert({
        where: { principalId: account.id },
        create: {
          principalId: account.id,
          principalType: account.type,
          phone: result.destination,
          phoneVerifiedAt: new Date(),
          smsEnabled: true,
        },
        update: {
          phone: result.destination,
          phoneVerifiedAt: new Date(),
          smsEnabled: true,
        },
      });
      await syncTwoFactorFlag(account);
      const backupCodes = await initialBackupCodes(account);
      await logSecurityEvent(account, "mfa.sms_enabled", metaOf(ctx));
      return { ok: true, backupCodes };
    }),

  smsDisable: protectedProcedure
    .input(z.object({ password: passwordSchema }))
    .mutation(async ({ ctx, input }) => {
      const account = await accountFor(ctx);
      await reauthenticate(account, input.password);
      await assertCanRemoveFactor(
        account,
        (m) => m.totp || m.email || m.passkeys > 0,
      );
      await db.accountSecurity.updateMany({
        where: { principalId: account.id },
        data: { smsEnabled: false, phone: null, phoneVerifiedAt: null },
      });
      await syncTwoFactorFlag(account);
      await logSecurityEvent(account, "mfa.sms_disabled", metaOf(ctx));
      return { ok: true };
    }),

  // ─── Email codes ─────────────────────────────────────────────────────

  emailStart: protectedProcedure
    .input(z.object({ email: z.string().max(254) }))
    .mutation(async ({ ctx, input }) => {
      const account = await accountFor(ctx);
      const email = normaliseEmail(input.email);
      if (!email) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Enter a valid email address.",
        });
      }
      await wrapConfigErrors(() =>
        issueOtp({
          principal: account,
          purpose: "VERIFY_EMAIL",
          channel: "EMAIL",
          destination: email,
          ip: ipFromHeaders(ctx.headers),
        }),
      );
      return { sentTo: maskEmail(email) };
    }),

  emailVerify: protectedProcedure
    .input(z.object({ code: codeSchema }))
    .mutation(async ({ ctx, input }) => {
      const account = await accountFor(ctx);
      await guardVerifyAttempt(account);
      const result = await verifyOtp(account, "VERIFY_EMAIL", input.code);
      if (!result) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "That code isn't valid or has expired.",
        });
      }
      await db.accountSecurity.upsert({
        where: { principalId: account.id },
        create: {
          principalId: account.id,
          principalType: account.type,
          contactEmail: result.destination,
          contactEmailVerifiedAt: new Date(),
          emailOtpEnabled: true,
        },
        update: {
          contactEmail: result.destination,
          contactEmailVerifiedAt: new Date(),
          emailOtpEnabled: true,
        },
      });
      await syncTwoFactorFlag(account);
      const backupCodes = await initialBackupCodes(account);
      await logSecurityEvent(account, "mfa.email_enabled", metaOf(ctx));
      return { ok: true, backupCodes };
    }),

  emailDisable: protectedProcedure
    .input(z.object({ password: passwordSchema }))
    .mutation(async ({ ctx, input }) => {
      const account = await accountFor(ctx);
      await reauthenticate(account, input.password);
      await assertCanRemoveFactor(
        account,
        (m) => m.totp || m.sms || m.passkeys > 0,
      );
      await db.accountSecurity.updateMany({
        where: { principalId: account.id },
        data: {
          emailOtpEnabled: false,
          contactEmail: null,
          contactEmailVerifiedAt: null,
        },
      });
      await syncTwoFactorFlag(account);
      await logSecurityEvent(account, "mfa.email_disabled", metaOf(ctx));
      return { ok: true };
    }),

  // ─── Passkeys ────────────────────────────────────────────────────────

  passkeyRegisterOptions: protectedProcedure.mutation(async ({ ctx }) => {
    const account = await accountFor(ctx);
    await enforce(`passkey-reg:${account.id}`, 20, 15 * MINUTE);
    return registrationOptions(
      account,
      account.loginId,
      account.displayName,
      ctx.headers,
    );
  }),

  passkeyRegisterVerify: protectedProcedure
    .input(
      z.object({
        challengeId: z.string(),
        response: registrationResponse,
        name: z.string().max(60).default("Passkey"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const account = await accountFor(ctx);
      const created = await verifyRegistration({
        principal: account,
        challengeId: input.challengeId,
        response: input.response,
        name: input.name,
        headers: ctx.headers,
      });
      await syncTwoFactorFlag(account);
      const backupCodes = await initialBackupCodes(account);
      await logSecurityEvent(account, "mfa.passkey_added", metaOf(ctx), {
        name: created.name,
      });
      return { ok: true, passkey: created, backupCodes };
    }),

  passkeyRename: protectedProcedure
    .input(z.object({ id: z.string(), name: z.string().trim().min(1).max(60) }))
    .mutation(async ({ ctx, input }) => {
      const account = await accountFor(ctx);
      const updated = await db.webAuthnCredential.updateMany({
        where: { id: input.id, principalId: account.id },
        data: { name: input.name },
      });
      if (updated.count === 0) throw new TRPCError({ code: "NOT_FOUND" });
      return { ok: true };
    }),

  passkeyDelete: protectedProcedure
    .input(z.object({ id: z.string(), password: passwordSchema }))
    .mutation(async ({ ctx, input }) => {
      const account = await accountFor(ctx);
      await reauthenticate(account, input.password);
      await assertCanRemoveFactor(
        account,
        (m) => m.totp || m.sms || m.email || m.passkeys > 1,
      );
      const deleted = await db.webAuthnCredential.deleteMany({
        where: { id: input.id, principalId: account.id },
      });
      if (deleted.count === 0) throw new TRPCError({ code: "NOT_FOUND" });
      await syncTwoFactorFlag(account);
      await logSecurityEvent(account, "mfa.passkey_removed", metaOf(ctx));
      return { ok: true };
    }),

  // ─── Backup codes ────────────────────────────────────────────────────

  backupCodesRegenerate: protectedProcedure
    .input(z.object({ password: passwordSchema }))
    .mutation(async ({ ctx, input }) => {
      const account = await accountFor(ctx);
      await reauthenticate(account, input.password);
      if (!hasSecondFactor(await getMethods(account))) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Turn on a two-factor method first.",
        });
      }
      const codes = await regenerateBackupCodes(account);
      await logSecurityEvent(
        account,
        "mfa.backup_codes_regenerated",
        metaOf(ctx),
      );
      return { codes };
    }),

  // ─── Devices and sessions ────────────────────────────────────────────

  revokeSession: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const account = await accountFor(ctx);
      const result = await db.authSession.updateMany({
        where: { id: input.id, principalId: account.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (result.count === 0) throw new TRPCError({ code: "NOT_FOUND" });
      await logSecurityEvent(account, "session.revoked", metaOf(ctx));
      return { ok: true, current: input.id === ctx.session.sessionId };
    }),

  revokeOtherSessions: protectedProcedure.mutation(async ({ ctx }) => {
    const account = await accountFor(ctx);
    const count = await revokeSessions(account, {
      exceptId: ctx.session.sessionId,
    });
    await logSecurityEvent(account, "session.revoked_others", metaOf(ctx), {
      count,
    });
    return { count };
  }),

  /** Ends every session including this one and forgets remembered devices. */
  signOutEverywhere: protectedProcedure
    .input(z.object({ password: passwordSchema }))
    .mutation(async ({ ctx, input }) => {
      const account = await accountFor(ctx);
      await reauthenticate(account, input.password);
      await revokeSessions(account);
      await bumpTokenVersion(account);
      await db.accountSecurity.updateMany({
        where: { principalId: account.id },
        data: { deviceTrustVersion: { increment: 1 } },
      });
      await logSecurityEvent(
        account,
        "session.signed_out_everywhere",
        metaOf(ctx),
      );
      return { ok: true };
    }),

  forgetTrustedDevices: protectedProcedure.mutation(async ({ ctx }) => {
    const account = await accountFor(ctx);
    await ensureSecurityRow(account);
    await db.accountSecurity.update({
      where: { principalId: account.id },
      data: { deviceTrustVersion: { increment: 1 } },
    });
    await logSecurityEvent(account, "mfa.trusted_devices_cleared", metaOf(ctx));
    return { ok: true };
  }),
});
