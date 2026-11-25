/**
 * Row-level access helpers for tRPC procedures.
 *
 * Role procedures (see trpc.ts) decide *who may call* a procedure. These helpers
 * decide *which rows* a caller may touch: a student only their own records, a
 * parent only their linked children, a teacher only classes they are allotted to.
 */
import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@prisma/client";
import { ROLE_GROUPS } from "~/server/api/trpc";
import { getSessionEmployee } from "~/server/utils/credential-generator";

type SessionUser = {
  id: string;
  accountId?: string;
  accountType?: string;
  username?: string;
  email?: string;
};

export type AccessCtx = {
  db: PrismaClient;
  session: { user: SessionUser } | null;
};

export const roleOf = (ctx: AccessCtx) =>
  (ctx.session?.user.accountType ?? "").toUpperCase();

export const hasRole = (ctx: AccessCtx, group: readonly string[]): boolean =>
  group.includes(roleOf(ctx));

export const isOffice = (ctx: AccessCtx) => hasRole(ctx, ROLE_GROUPS.OFFICE);
export const isStaff = (ctx: AccessCtx) => hasRole(ctx, ROLE_GROUPS.STAFF);
export const isLeadership = (ctx: AccessCtx) =>
  hasRole(ctx, ROLE_GROUPS.LEADERSHIP);

const forbidden = (message = "You do not have access to this record") =>
  new TRPCError({ code: "FORBIDDEN", message });

/** The studentId of the logged-in STUDENT account, or null. */
export async function getSessionStudentId(
  ctx: AccessCtx,
): Promise<string | null> {
  const user = ctx.session?.user;
  if (!user?.accountId || roleOf(ctx) !== "STUDENT") return null;
  const student = await ctx.db.students.findFirst({
    where: { registrationNumber: user.accountId },
    select: { studentId: true },
  });
  return student?.studentId ?? null;
}

/** Student ids the caller may read as a student/parent (null = unrestricted staff). */
export async function getOwnStudentIds(
  ctx: AccessCtx,
): Promise<string[] | null> {
  const role = roleOf(ctx);
  if (role === "STUDENT") {
    const id = await getSessionStudentId(ctx);
    return id ? [id] : [];
  }
  if (role === "PARENT") {
    const parent = await ctx.db.parentGuardian.findUnique({
      where: { guardentId: ctx.session!.user.id },
      select: { linkedStudentIds: true, isActive: true },
    });
    return parent?.isActive ? parent.linkedStudentIds : [];
  }
  if (isStaff(ctx)) return null;
  return [];
}

/**
 * Read access to one student's records.
 * Staff (office + teachers) may read any student; students only themselves;
 * parents only linked children; everyone else nothing.
 */
export async function assertCanReadStudent(ctx: AccessCtx, studentId: string) {
  const own = await getOwnStudentIds(ctx);
  if (own === null) return;
  if (!own.includes(studentId)) throw forbidden();
}

/** Employee record of the caller; throws if none is linked. */
export async function requireSessionEmployee(ctx: AccessCtx) {
  const employee = await getSessionEmployee(ctx);
  if (!employee) {
    throw forbidden(
      "Your account is not linked to an employee record. Ask an administrator to link it.",
    );
  }
  return employee;
}

/**
 * Write access for academic work on a class (attendance, marks, diary).
 * Office staff may write anywhere; a TEACHER must be allotted (ClassSubject)
 * to the class, optionally for a specific subject and session.
 */
export async function assertCanTeachClass(
  ctx: AccessCtx,
  where: { classId: string; subjectId?: string; sessionId?: string },
) {
  if (isOffice(ctx)) return;
  if (roleOf(ctx) !== "TEACHER") throw forbidden();
  const employee = await requireSessionEmployee(ctx);
  const allotted = await ctx.db.classSubject.findFirst({
    where: {
      employeeId: employee.employeeId,
      classId: where.classId,
      ...(where.subjectId ? { subjectId: where.subjectId } : {}),
      ...(where.sessionId ? { sessionId: where.sessionId } : {}),
    },
    select: { csId: true },
  });
  if (!allotted) {
    throw forbidden("You are not allotted to teach this class/subject");
  }
}

/** Same as assertCanTeachClass but keyed by a ClassSubject id. */
export async function assertCanTeachClassSubject(
  ctx: AccessCtx,
  classSubjectId: string,
) {
  if (isOffice(ctx)) return;
  if (roleOf(ctx) !== "TEACHER") throw forbidden();
  const employee = await requireSessionEmployee(ctx);
  const cs = await ctx.db.classSubject.findUnique({
    where: { csId: classSubjectId },
    select: { employeeId: true },
  });
  if (cs?.employeeId !== employee.employeeId) {
    throw forbidden("You are not allotted to this class subject");
  }
}

/** Reject an approval by the same employee who created/submitted the record. */
export function assertNotSelfApproval(
  approverEmployeeId: string,
  ...makerEmployeeIds: (string | null | undefined)[]
) {
  if (makerEmployeeIds.some((id) => id && id === approverEmployeeId)) {
    throw forbidden(
      "You cannot approve a request you created or already approved",
    );
  }
}

/** Roles that only ADMIN or PRINCIPAL may grant. */
const PRIVILEGED_ROLES = ["ADMIN", "PRINCIPAL", "HEAD"];

/** Clerks (and HEAD) may not create or promote accounts into leadership roles. */
export function assertCanAssignRole(
  ctx: AccessCtx,
  role: string | undefined | null,
) {
  if (!role || !PRIVILEGED_ROLES.includes(role.toUpperCase())) return;
  if (!["ADMIN", "PRINCIPAL"].includes(roleOf(ctx))) {
    throw forbidden(
      "Only an ADMIN or PRINCIPAL can grant ADMIN, PRINCIPAL or HEAD access",
    );
  }
}

/** Office staff may read any employee's HR/payroll data; other employees only their own. */
export async function assertCanReadEmployee(
  ctx: AccessCtx,
  employeeId: string | undefined,
) {
  if (isOffice(ctx)) return;
  if (!hasRole(ctx, ROLE_GROUPS.EMPLOYEE) || !employeeId) throw forbidden();
  const me = await requireSessionEmployee(ctx);
  if (me.employeeId !== employeeId) throw forbidden();
}
