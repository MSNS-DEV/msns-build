/**
 * Admin-only account administration: roles, suspension, lockouts, password
 * and 2FA resets, session revocation, per-role 2FA policy and the audit log.
 * Restricted to ADMIN and PRINCIPAL (see accountAdminProcedure).
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { hash } from "bcryptjs";
import type { Designation, Prisma } from "@prisma/client";
import {
  accountAdminProcedure,
  ACCOUNT_ADMIN_ROLES,
  createTRPCRouter,
} from "~/server/api/trpc";
import { db } from "~/server/db";
import { accountKey } from "~/server/auth/login-throttle";
import { maskEmail, maskPhone } from "~/server/security/contact";
import { randomPassword } from "~/server/security/crypto";
import {
  logAdminAction,
  logSecurityEvent,
  metaFromHeaders,
} from "~/server/security/events";
import {
  getMethods,
  getSecurityRow,
  hasSecondFactor,
  removeAllFactors,
} from "~/server/security/mfa";
import {
  bumpTokenVersion,
  loadAccount,
  type PrincipalAccount,
} from "~/server/security/principal";
import { revokeSessions } from "~/server/security/sessions";

const EMPLOYEE_ROLES = [
  "ADMIN",
  "PRINCIPAL",
  "HEAD",
  "CLERK",
  "TEACHER",
  "WORKER",
] as const;
const POLICY_ROLES = [...EMPLOYEE_ROLES, "STUDENT", "PARENT"] as const;

const target = z.object({
  id: z.string().min(1),
  type: z.enum(["USER", "PARENT"]),
});

type AdminCtx = {
  session: { user: { id: string; accountType: string; username: string } };
  headers: Headers;
};

const actorOf = (ctx: AdminCtx) => ({
  id: ctx.session.user.id,
  role: ctx.session.user.accountType.toUpperCase(),
  name: ctx.session.user.username,
});

async function loadTarget(input: z.infer<typeof target>) {
  const account = await loadAccount(input);
  if (!account) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Account not found" });
  }
  return account;
}

/**
 * Admins manage their own account from Profile → Security, not here, and only
 * an ADMIN may act on another ADMIN account.
 */
function assertCanManage(ctx: AdminCtx, account: PrincipalAccount) {
  if (account.id === ctx.session.user.id) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Use Profile → Security to change your own account.",
    });
  }
  if (account.role.toUpperCase() === "ADMIN" && actorOf(ctx).role !== "ADMIN") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only an ADMIN can change another ADMIN account.",
    });
  }
}

/** Never leave the school without an active ADMIN. */
async function assertNotLastAdmin(account: PrincipalAccount) {
  if (account.type !== "USER" || account.role !== "ADMIN") return;
  const others = await db.user.count({
    where: { accountType: "ADMIN", isActive: true, id: { not: account.id } },
  });
  if (others === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This is the only active ADMIN account.",
    });
  }
}

async function audit(
  ctx: AdminCtx,
  account: PrincipalAccount,
  action: string,
  detail?: Prisma.InputJsonValue,
) {
  const meta = metaFromHeaders(ctx.headers);
  await logAdminAction({
    actor: actorOf(ctx),
    target: { id: account.id, type: account.type, name: account.displayName },
    action,
    detail,
    ip: meta.ip,
  });
  await logSecurityEvent(account, `admin.${action}`, meta, {
    by: actorOf(ctx).name,
    ...(detail && typeof detail === "object" && !Array.isArray(detail)
      ? (detail as Record<string, Prisma.InputJsonValue>)
      : {}),
  });
}

/** Sign the account out everywhere and forget remembered devices. */
async function endAllSessions(account: PrincipalAccount) {
  await revokeSessions(account);
  await bumpTokenVersion(account);
  await db.accountSecurity.updateMany({
    where: { principalId: account.id },
    data: { deviceTrustVersion: { increment: 1 } },
  });
}

async function lockedIdentifiers(): Promise<Set<string>> {
  const rows = await db.loginAttempt.findMany({
    where: { key: { startsWith: "acct:" }, lockedUntil: { gt: new Date() } },
    select: { key: true },
  });
  return new Set(rows.map((r) => r.key.slice("acct:".length)));
}

export const accountsRouter = createTRPCRouter({
  list: accountAdminProcedure
    .input(
      z.object({
        kind: z.enum(["users", "parents"]).default("users"),
        search: z.string().trim().max(100).optional(),
        role: z.enum([...EMPLOYEE_ROLES, "STUDENT"]).optional(),
        status: z.enum(["all", "active", "suspended", "locked"]).default("all"),
        twoFactor: z.enum(["all", "on", "off"]).default("all"),
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(5).max(100).default(25),
      }),
    )
    .query(async ({ input }) => {
      const locked = await lockedIdentifiers();
      const skip = (input.page - 1) * input.pageSize;
      const q = input.search;

      if (input.kind === "parents") {
        const where: Prisma.ParentGuardianWhereInput = {
          ...(q && {
            OR: [
              { username: { contains: q, mode: "insensitive" } },
              { mobileNumber: { contains: q } },
            ],
          }),
          ...(input.status === "active" && { isActive: true }),
          ...(input.status === "suspended" && { isActive: false }),
          ...(input.status === "locked" && {
            username: { in: [...locked] },
          }),
        };
        const [total, parents] = await Promise.all([
          db.parentGuardian.count({ where }),
          db.parentGuardian.findMany({
            where,
            orderBy: { createdAt: "desc" },
            skip,
            take: input.pageSize,
            select: {
              guardentId: true,
              username: true,
              mobileNumber: true,
              isActive: true,
              createdAt: true,
              linkedStudentIds: true,
            },
          }),
        ]);
        const ids = parents.map((p) => p.guardentId);
        const [secs, passkeys, lastSeen] = await Promise.all([
          db.accountSecurity.findMany({ where: { principalId: { in: ids } } }),
          db.webAuthnCredential.groupBy({
            by: ["principalId"],
            where: { principalId: { in: ids } },
            _count: true,
          }),
          db.authSession.groupBy({
            by: ["principalId"],
            where: { principalId: { in: ids } },
            _max: { createdAt: true },
          }),
        ]);
        const rows = parents.map((p) => {
          const sec = secs.find((s) => s.principalId === p.guardentId);
          const twoFactor =
            !!sec?.totpEnabledAt ||
            !!(sec?.smsEnabled && sec.phoneVerifiedAt) ||
            !!(sec?.emailOtpEnabled && sec.contactEmailVerifiedAt) ||
            passkeys.some((k) => k.principalId === p.guardentId);
          return {
            id: p.guardentId,
            type: "PARENT" as const,
            name: p.username,
            loginId: p.username,
            accountId: maskPhone(p.mobileNumber) ?? "—",
            role: "PARENT",
            isActive: p.isActive,
            locked: locked.has(p.username.trim().toLowerCase()),
            twoFactor,
            lastSignInAt:
              lastSeen.find((l) => l.principalId === p.guardentId)?._max
                .createdAt ?? null,
            createdAt: p.createdAt,
            linkedStudents: p.linkedStudentIds.length,
          };
        });
        const filtered =
          input.twoFactor === "all"
            ? rows
            : rows.filter((r) => r.twoFactor === (input.twoFactor === "on"));
        return { total, rows: filtered };
      }

      const where: Prisma.UserWhereInput = {
        accountType: input.role
          ? (input.role as Designation)
          : { notIn: ["NONE", "ALL"] },
        ...(q && {
          OR: [
            { username: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            { accountId: { contains: q, mode: "insensitive" } },
          ],
        }),
        ...(input.status === "active" && { isActive: true }),
        ...(input.status === "suspended" && { isActive: false }),
        ...(input.status === "locked" && { email: { in: [...locked] } }),
        ...(input.twoFactor !== "all" && {
          twoFactorAuth: input.twoFactor === "on",
        }),
      };
      const [total, users] = await Promise.all([
        db.user.count({ where }),
        db.user.findMany({
          where,
          orderBy: [{ accountType: "asc" }, { username: "asc" }],
          skip,
          take: input.pageSize,
          select: {
            id: true,
            username: true,
            email: true,
            accountId: true,
            accountType: true,
            isActive: true,
            twoFactorAuth: true,
            mustChangePassword: true,
            createdAt: true,
          },
        }),
      ]);
      const lastSeen = await db.authSession.groupBy({
        by: ["principalId"],
        where: { principalId: { in: users.map((u) => u.id) } },
        _max: { createdAt: true },
      });
      return {
        total,
        rows: users.map((u) => ({
          id: u.id,
          type: "USER" as const,
          name: u.username,
          loginId: u.email,
          accountId: u.accountId,
          role: u.accountType as string,
          isActive: u.isActive,
          locked: locked.has(u.email.toLowerCase()),
          twoFactor: u.twoFactorAuth,
          mustChangePassword: u.mustChangePassword,
          lastSignInAt:
            lastSeen.find((l) => l.principalId === u.id)?._max.createdAt ??
            null,
          createdAt: u.createdAt,
        })),
      };
    }),

  get: accountAdminProcedure.input(target).query(async ({ input }) => {
    const account = await loadTarget(input);
    const [methods, sec, passkeys, sessions, events, lockRow, auditRows] =
      await Promise.all([
        getMethods(account),
        getSecurityRow(account),
        db.webAuthnCredential.findMany({
          where: { principalId: account.id },
          select: { id: true, name: true, createdAt: true, lastUsedAt: true },
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
          take: 40,
          select: {
            id: true,
            type: true,
            createdAt: true,
            ip: true,
            detail: true,
          },
        }),
        db.loginAttempt.findUnique({
          where: { key: accountKey(account.loginId) },
        }),
        db.adminAuditLog.findMany({
          where: { targetId: account.id },
          orderBy: { createdAt: "desc" },
          take: 20,
        }),
      ]);
    const user =
      account.type === "USER"
        ? await db.user.findUnique({
            where: { id: account.id },
            select: {
              suspendedAt: true,
              suspendedReason: true,
              createdAt: true,
            },
          })
        : null;
    return {
      id: account.id,
      type: account.type,
      name: account.displayName,
      loginId: account.loginId,
      accountId: account.accountId,
      role: account.role,
      isActive: account.isActive,
      mustChangePassword: account.mustChangePassword,
      suspendedAt: user?.suspendedAt ?? null,
      suspendedReason: user?.suspendedReason ?? null,
      locked: !!lockRow?.lockedUntil && lockRow.lockedUntil > new Date(),
      lockedUntil: lockRow?.lockedUntil ?? null,
      recentFailures: lockRow?.failures ?? 0,
      has2fa: hasSecondFactor(methods),
      methods,
      phone: maskPhone(sec?.phone),
      contactEmail: maskEmail(sec?.contactEmail),
      passkeys,
      sessions,
      events,
      audit: auditRows,
    };
  }),

  setRole: accountAdminProcedure
    .input(z.object({ id: z.string(), role: z.enum(EMPLOYEE_ROLES) }))
    .mutation(async ({ ctx, input }) => {
      const account = await loadTarget({ id: input.id, type: "USER" });
      assertCanManage(ctx, account);
      if (
        !EMPLOYEE_ROLES.includes(
          account.role as (typeof EMPLOYEE_ROLES)[number],
        )
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only staff accounts can change role.",
        });
      }
      if (input.role === "ADMIN" && actorOf(ctx).role !== "ADMIN") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only an ADMIN can grant ADMIN access.",
        });
      }
      if (account.role === input.role) return { ok: true };
      if (account.role === "ADMIN") await assertNotLastAdmin(account);

      await db.$transaction([
        db.user.update({
          where: { id: account.id },
          data: { accountType: input.role },
        }),
        db.employees.updateMany({
          where: { registrationNumber: account.accountId },
          data: { designation: input.role },
        }),
      ]);
      // Privilege change: make the user sign in again with the new role.
      await endAllSessions(account);
      await audit(ctx, account, "role_changed", {
        from: account.role,
        to: input.role,
      });
      return { ok: true };
    }),

  setActive: accountAdminProcedure
    .input(
      target.extend({
        active: z.boolean(),
        reason: z.string().trim().max(300).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const account = await loadTarget(input);
      assertCanManage(ctx, account);
      if (!input.active) await assertNotLastAdmin(account);
      if (account.type === "PARENT") {
        await db.parentGuardian.update({
          where: { guardentId: account.id },
          data: { isActive: input.active },
        });
      } else {
        await db.user.update({
          where: { id: account.id },
          data: {
            isActive: input.active,
            suspendedAt: input.active ? null : new Date(),
            suspendedReason: input.active ? null : (input.reason ?? null),
          },
        });
      }
      if (!input.active) await endAllSessions(account);
      await audit(ctx, account, input.active ? "reactivated" : "suspended", {
        ...(input.reason && { reason: input.reason }),
      });
      return { ok: true };
    }),

  unlock: accountAdminProcedure
    .input(target)
    .mutation(async ({ ctx, input }) => {
      const account = await loadTarget(input);
      await db.loginAttempt.deleteMany({
        where: {
          key: {
            in: [
              accountKey(account.loginId),
              `mfa-verify:${account.id}`,
              `otp-send:acct:${account.id}`,
            ],
          },
        },
      });
      await audit(ctx, account, "unlocked");
      return { ok: true };
    }),

  forcePasswordReset: accountAdminProcedure
    .input(target)
    .mutation(async ({ ctx, input }) => {
      const account = await loadTarget(input);
      assertCanManage(ctx, account);
      const temporaryPassword = randomPassword(12);
      const passwordHash = await hash(temporaryPassword, 12);
      if (account.type === "PARENT") {
        await db.parentGuardian.update({
          where: { guardentId: account.id },
          data: { passwordHash, mustChangePassword: true },
        });
      } else {
        await db.user.update({
          where: { id: account.id },
          data: { password: passwordHash, mustChangePassword: true },
        });
      }
      await db.loginAttempt.deleteMany({
        where: { key: accountKey(account.loginId) },
      });
      await endAllSessions(account);
      await audit(ctx, account, "password_reset");
      // Shown once to the admin; never stored or logged in plain text.
      return { temporaryPassword };
    }),

  resetTwoFactor: accountAdminProcedure
    .input(target)
    .mutation(async ({ ctx, input }) => {
      const account = await loadTarget(input);
      assertCanManage(ctx, account);
      await removeAllFactors(account);
      await endAllSessions(account);
      await audit(ctx, account, "two_factor_reset");
      return { ok: true };
    }),

  revokeSessions: accountAdminProcedure
    .input(target)
    .mutation(async ({ ctx, input }) => {
      const account = await loadTarget(input);
      if (account.role === "ADMIN" && actorOf(ctx).role !== "ADMIN") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only an ADMIN can change another ADMIN account.",
        });
      }
      await endAllSessions(account);
      await audit(ctx, account, "sessions_revoked");
      return { ok: true };
    }),

  policies: accountAdminProcedure.query(async () => {
    const [policies, userCounts] = await Promise.all([
      db.roleSecurityPolicy.findMany(),
      db.user.groupBy({
        by: ["accountType", "twoFactorAuth"],
        where: { isActive: true },
        _count: true,
      }),
    ]);
    const parentTotal = await db.parentGuardian.count({
      where: { isActive: true },
    });
    const parentIds = (
      await db.accountSecurity.findMany({
        where: {
          principalType: "PARENT",
          OR: [
            { totpEnabledAt: { not: null } },
            { smsEnabled: true, phoneVerifiedAt: { not: null } },
            { emailOtpEnabled: true, contactEmailVerifiedAt: { not: null } },
          ],
        },
        select: { principalId: true },
      })
    ).map((r) => r.principalId);
    const parentPasskeys = await db.webAuthnCredential.groupBy({
      by: ["principalId"],
      where: { principalType: "PARENT" },
    });
    const parentsWith2fa = new Set([
      ...parentIds,
      ...parentPasskeys.map((p) => p.principalId),
    ]).size;

    return POLICY_ROLES.map((role) => {
      const counts =
        role === "PARENT"
          ? { total: parentTotal, with2fa: parentsWith2fa }
          : {
              total: userCounts
                .filter((c) => c.accountType === role)
                .reduce((n, c) => n + c._count, 0),
              with2fa: userCounts
                .filter((c) => c.accountType === role && c.twoFactorAuth)
                .reduce((n, c) => n + c._count, 0),
            };
      const policy = policies.find((p) => p.role === role);
      return {
        role,
        require2fa: !!policy?.require2fa,
        updatedAt: policy?.updatedAt ?? null,
        updatedBy: policy?.updatedBy ?? null,
        ...counts,
      };
    });
  }),

  setPolicy: accountAdminProcedure
    .input(z.object({ role: z.enum(POLICY_ROLES), require2fa: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (
        ACCOUNT_ADMIN_ROLES.includes(
          input.role as (typeof ACCOUNT_ADMIN_ROLES)[number],
        ) &&
        !input.require2fa &&
        actorOf(ctx).role !== "ADMIN"
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only an ADMIN can relax 2FA for administrator roles.",
        });
      }
      await db.roleSecurityPolicy.upsert({
        where: { role: input.role },
        create: {
          role: input.role,
          require2fa: input.require2fa,
          updatedBy: actorOf(ctx).name,
        },
        update: { require2fa: input.require2fa, updatedBy: actorOf(ctx).name },
      });
      await logAdminAction({
        actor: actorOf(ctx),
        target: { id: input.role, type: "ROLE", name: input.role },
        action: input.require2fa ? "policy_require_2fa" : "policy_optional_2fa",
        ip: metaFromHeaders(ctx.headers).ip,
      });
      return { ok: true };
    }),

  auditLog: accountAdminProcedure
    .input(
      z.object({
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(10).max(100).default(30),
      }),
    )
    .query(async ({ input }) => {
      const [total, rows] = await Promise.all([
        db.adminAuditLog.count(),
        db.adminAuditLog.findMany({
          orderBy: { createdAt: "desc" },
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
        }),
      ]);
      return { total, rows };
    }),
});
