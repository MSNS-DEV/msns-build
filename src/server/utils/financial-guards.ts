import { TRPCError } from "@trpc/server";
import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

/** A voucher counts as paid when any payment flag, date or amount is recorded on it. */
export const PAID_VOUCHER_WHERE: Prisma.FeeStudentClassWhereInput = {
  OR: [
    { tuitionPaid: true },
    { examFundPaid: true },
    { computerLabPaid: true },
    { studentIdCardPaid: true },
    { infoAndCallsPaid: true },
    { admissionFeePaid: true },
    { paidAt: { not: null } },
    { amountPaid: { gt: 0 } },
  ],
};

/**
 * Refuses an operation that would delete fee vouchers with payments recorded.
 * Collection history must survive admin clean-ups; unpaid vouchers may still be removed.
 */
export async function assertNoPaidVouchers(
  db: Db,
  where: Prisma.FeeStudentClassWhereInput,
  action: string,
) {
  const paid = await db.feeStudentClass.count({
    where: { AND: [where, PAID_VOUCHER_WHERE] },
  });
  if (paid > 0) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Cannot ${action}: ${paid} fee voucher(s) have payments recorded. Paid fee history is kept for the accounts.`,
    });
  }
}

/** Refuses an operation that would delete salaries already marked PAID. */
export async function assertNoPaidSalaries(
  db: Db,
  where: Prisma.SalaryWhereInput,
  action: string,
) {
  const paid = await db.salary.count({
    where: { AND: [where, { status: "PAID" }] },
  });
  if (paid > 0) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Cannot ${action}: ${paid} salary payment(s) are marked PAID. Paid payroll history is kept for the accounts.`,
    });
  }
}
