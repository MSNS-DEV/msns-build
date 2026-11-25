import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";

import { auth } from "~/server/auth";
import { db } from "~/server/db";

export const createTRPCContext = async (opts: { headers: Headers }) => {
  const session = await auth();

  return {
    db,
    session,
    ...opts,
  };
};

const t = initTRPC.context<typeof createTRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

export const createCallerFactory = t.createCallerFactory;

export const createTRPCRouter = t.router;
const timingMiddleware = t.middleware(async ({ next, path }) => {
  const start = Date.now();

  if (t._config.isDev) {
    // artificial delay in dev
    const waitMs = Math.floor(Math.random() * 400) + 100;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  const result = await next();

  const end = Date.now();
  console.log(`[TRPC] ${path} took ${end - start}ms to execute`);

  return result;
});

export const publicProcedure = t.procedure.use(timingMiddleware);

/**
 * Mutations still allowed while an account must replace its default password
 * or enrol a second factor (both are done from Profile → Security).
 */
const ALLOWED_WHILE_ACCOUNT_SETUP_REQUIRED =
  /^(profile|security|notification|mobile)\./;

/**
 * Signed in, possibly still waiting for the second factor. Only the
 * two-factor verification procedures should use this.
 */
export const pendingSessionProcedure = t.procedure
  .use(timingMiddleware)
  .use(async ({ ctx, next }) => {
    if (!ctx.session?.user) {
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }
    return next({
      ctx: {
        session: { ...ctx.session, user: ctx.session.user },
      },
    });
  });

export const protectedProcedure = t.procedure
  .use(timingMiddleware)
  .use(async ({ ctx, next, type, path }) => {
    if (!ctx.session?.user) {
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }
    if (ctx.session.user.twoFactorPending) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Two-factor verification required.",
      });
    }
    if (
      type === "mutation" &&
      !ALLOWED_WHILE_ACCOUNT_SETUP_REQUIRED.test(path)
    ) {
      if (ctx.session.user.twoFactorEnrollRequired) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Your role requires two-factor authentication. Set it up in Profile → Security first.",
        });
      }
      if (ctx.session.user.mustChangePassword) {
        // The token can lag behind a password change; confirm against the DB.
        const isParent = ctx.session.user.accountType === "PARENT";
        const pending = isParent
          ? (
              await ctx.db.parentGuardian.findUnique({
                where: { guardentId: ctx.session.user.id },
                select: { mustChangePassword: true },
              })
            )?.mustChangePassword
          : (
              await ctx.db.user.findUnique({
                where: { id: ctx.session.user.id },
                select: { mustChangePassword: true },
              })
            )?.mustChangePassword;
        if (pending) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message:
              "Please change your default password (Profile → Security) before making changes.",
          });
        }
      }
    }
    return next({
      ctx: {
        session: { ...ctx.session, user: ctx.session.user },
      },
    });
  });

/** Enforces that the user is logged in and possesses one of the allowed account types/roles. */
export const enforceRoles = (allowedRoles: string[]) =>
  t.middleware(({ ctx, next }) => {
    if (!ctx.session?.user) {
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }
    const role = (ctx.session.user.accountType ?? "").toUpperCase();
    if (!allowedRoles.includes(role)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `Action not permitted for role ${role}`,
      });
    }
    return next({
      ctx: {
        session: { ...ctx.session, user: ctx.session.user },
      },
    });
  });

/**
 * Role groups.
 * - LEADERSHIP: school leadership (can approve, grant privileged roles, see everything)
 * - OFFICE:     leadership + clerical staff (fees, enrolment, payroll data entry, ERP data entry)
 * - STAFF:      office + teachers (academic work: attendance, marks, diary)
 * - EMPLOYEE:   any employee account (staff + workers)
 */
export const ROLE_GROUPS = {
  LEADERSHIP: ["ADMIN", "PRINCIPAL", "HEAD"],
  OFFICE: ["ADMIN", "PRINCIPAL", "HEAD", "CLERK"],
  STAFF: ["ADMIN", "PRINCIPAL", "HEAD", "CLERK", "TEACHER"],
  EMPLOYEE: ["ADMIN", "PRINCIPAL", "HEAD", "CLERK", "TEACHER", "WORKER"],
} as const;

/** Leadership only: approvals, privileged account management, school-wide settings. */
export const leadershipProcedure = protectedProcedure.use(
  enforceRoles([...ROLE_GROUPS.LEADERSHIP]),
);

/**
 * Account administration (roles, suspension, 2FA resets, security policy).
 * ADMIN and PRINCIPAL only: resetting someone's 2FA or password is a takeover
 * path, so it is narrower than the LEADERSHIP group (which includes HEAD).
 */
export const ACCOUNT_ADMIN_ROLES = ["ADMIN", "PRINCIPAL"] as const;
export const accountAdminProcedure = protectedProcedure.use(
  enforceRoles([...ACCOUNT_ADMIN_ROLES]),
);

/** Leadership + clerks: day-to-day administration. */
export const officeProcedure = protectedProcedure.use(
  enforceRoles([...ROLE_GROUPS.OFFICE]),
);

/** Finance data entry (fees, payroll, expenses, ERP). Approvals use leadershipProcedure. */
export const financeProcedure = officeProcedure;

/** Legacy names kept for existing routers; all mean "office staff". */
export const adminProcedure = officeProcedure;
export const managementProcedure = officeProcedure;
export const clerkProcedure = officeProcedure;

/** Office staff + teachers. */
export const teacherProcedure = protectedProcedure.use(
  enforceRoles([...ROLE_GROUPS.STAFF]),
);
export const staffProcedure = teacherProcedure;

/** Any employee account (excludes STUDENT and PARENT). */
export const employeeProcedure = protectedProcedure.use(
  enforceRoles([...ROLE_GROUPS.EMPLOYEE]),
);
