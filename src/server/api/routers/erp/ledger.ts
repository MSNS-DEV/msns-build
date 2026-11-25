import { z } from "zod";
import { createTRPCRouter, financeProcedure } from "../../trpc";
import { TRPCError } from "@trpc/server";
import { computeFeeRows } from "~/lib/fee-calc";
import { pkDayEnd, pkDayStart, sessionWindow } from "~/server/utils/pk-time";
import { type Prisma } from "@prisma/client";
import { getSessionEmployee } from "~/server/utils/credential-generator";

export const ledgerRouter = createTRPCRouter({
  // FR-ERP-34/35: Create immutable double-entry ledger record
  // NFR-SEC-10: append-only, no update/delete
  createEntry: financeProcedure
    .input(
      z.object({
        entries: z
          .array(
            z.object({
              entryType: z.enum(["DEBIT", "CREDIT"]),
              accountType: z.enum(["Income", "Expenditure", "Asset", "Liability"]),
              accountCode: z.string().min(1),
              amount: z.number().positive(),
              description: z.string().min(1),
              sourceType: z.string().min(1),
              sourceId: z.string().optional(),
              justification: z.string().optional(),
            }),
          )
          .min(2)
          .refine(
            (entries) => {
              const debits = entries.filter((e) => e.entryType === "DEBIT").reduce((s, e) => s + e.amount, 0);
              const credits = entries.filter((e) => e.entryType === "CREDIT").reduce((s, e) => s + e.amount, 0);
              return Math.abs(debits - credits) < 0.01; // float tolerance
            },
            { message: "Double-entry: total debits must equal total credits" },
          ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const employeeRecord = await getSessionEmployee(ctx);
      if (!employeeRecord) throw new TRPCError({ code: "UNAUTHORIZED", message: "Employee not found" });

      const created = await ctx.db.$transaction(
        input.entries.map((entry) =>
          ctx.db.financialLedgerEntry.create({
            data: { ...entry, createdBy: employeeRecord.employeeId },
          }),
        ),
      );

      return { success: true, count: created.length, entries: created };
    }),

  // FR-ERP-36: General Ledger view
  getGeneralLedger: financeProcedure
    .input(
      z.object({
        fromDate: z.date().optional(),
        toDate: z.date().optional(),
        accountType: z.enum(["Income", "Expenditure", "Asset", "Liability"]).optional(),
        sourceType: z.string().optional(),
        page: z.number().default(1),
        pageSize: z.number().default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const where: Prisma.FinancialLedgerEntryWhereInput = {};
      if (input.fromDate || input.toDate) {
        where.transactionDate = {};
        if (input.fromDate) where.transactionDate.gte = input.fromDate;
        if (input.toDate) where.transactionDate.lte = input.toDate;
      }
      if (input.accountType) where.accountType = input.accountType;
      if (input.sourceType) where.sourceType = input.sourceType;

      const [entries, total] = await Promise.all([
        ctx.db.financialLedgerEntry.findMany({
          where,
          orderBy: { transactionDate: "desc" },
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
          include: { CreatedBy: { select: { employeeName: true } } },
        }),
        ctx.db.financialLedgerEntry.count({ where }),
      ]);

      return { entries, total, page: input.page, pageSize: input.pageSize };
    }),

  // FR-ERP-37: Trial Balance
  getTrialBalance: financeProcedure
    .input(
      z.object({
        fromDate: z.date().optional(),
        toDate: z.date().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const where: Prisma.FinancialLedgerEntryWhereInput = {};
      if (input.fromDate || input.toDate) {
        where.transactionDate = {};
        if (input.fromDate) where.transactionDate.gte = input.fromDate;
        if (input.toDate) where.transactionDate.lte = input.toDate;
      }

      const entries = await ctx.db.financialLedgerEntry.findMany({
        where,
        select: { entryType: true, accountCode: true, accountType: true, amount: true },
      });

      const byAccount = entries.reduce(
        (acc, entry) => {
          acc[entry.accountCode] ??= {
            accountCode: entry.accountCode,
            accountType: entry.accountType,
            totalDebit: 0,
            totalCredit: 0,
          };
          if (entry.entryType === "DEBIT") {
            acc[entry.accountCode]!.totalDebit += entry.amount;
          } else {
            acc[entry.accountCode]!.totalCredit += entry.amount;
          }
          return acc;
        },
        {} as Record<string, { accountCode: string; accountType: string; totalDebit: number; totalCredit: number }>,
      );

      const accounts = Object.values(byAccount);
      const totalDebits = accounts.reduce((s, a) => s + a.totalDebit, 0);
      const totalCredits = accounts.reduce((s, a) => s + a.totalCredit, 0);
      const isBalanced = Math.abs(totalDebits - totalCredits) < 0.01;

      return { accounts, totalDebits, totalCredits, isBalanced };
    }),

  // FR-ERP-38/39: P&L Statement
  getProfitLoss: financeProcedure
    .input(
      z.object({
        sessionId: z.string().cuid(),
        fromDate: z.date().optional(),
        toDate: z.date().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const session = await ctx.db.sessions.findUnique({
        where: { sessionId: input.sessionId },
      });
      if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });

      // Everything is scoped to the session's dates (or the requested window inside it).
      const window = sessionWindow(session);
      const from = input.fromDate ? pkDayStart(input.fromDate) : window.from;
      const to = input.toDate ? pkDayEnd(input.toDate) : window.to;
      const explicitWindow = !!(input.fromDate ?? input.toDate);
      const inWindow = (d: Date | null | undefined) =>
        !!d && (!from || d >= from) && (!to || d <= to);
      const dateFilter = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };

      // Fee income: amounts collected on this session's vouchers, each component counted
      // once (annual components once per student-year), net of discounts.
      const sessionVouchers = await ctx.db.feeStudentClass.findMany({
        where: { StudentClass: { sessionId: input.sessionId } },
        include: { fees: true },
      });
      const voucherAmounts = computeFeeRows(sessionVouchers);
      const totalIncome = sessionVouchers.reduce((sum, v) => {
        if (explicitWindow && !inWindow(v.paidAt)) return sum;
        return sum + (voucherAmounts.get(v.sfcId)?.paid ?? 0);
      }, 0);

      // Salary expenditure (paid)
      const salaryExpenditure = await ctx.db.salary.aggregate({
        where: {
          sessionId: input.sessionId,
          status: "PAID",
          ...(explicitWindow ? { paymentDate: dateFilter } : {}),
        },
        _sum: { amount: true, allowances: true, bonus: true, deductions: true },
      });

      const totalSalaries =
        (salaryExpenditure._sum.amount ?? 0) +
        (salaryExpenditure._sum.allowances ?? 0) +
        (salaryExpenditure._sum.bonus ?? 0) -
        (salaryExpenditure._sum.deductions ?? 0);

      // Approved direct expenses dated within the window
      const directExpenses = await ctx.db.directExpense.aggregate({
        where: { isApproved: true, expenseDate: dateFilter },
        _sum: { amount: true },
      });

      // Petty cash disbursements from this session's register
      const pettyCashRegister = await ctx.db.pettyCashRegister.findUnique({
        where: { sessionId: input.sessionId },
      });

      let pettyCashSpend = 0;
      if (pettyCashRegister) {
        const pcSpend = await ctx.db.pettyCashDisbursement.aggregate({
          where: {
            registerId: pettyCashRegister.registerId,
            ...(explicitWindow ? { date: dateFilter } : {}),
          },
          _sum: { amount: true },
        });
        pettyCashSpend = pcSpend._sum.amount ?? 0;
      }

      // Paid POs raised within the window (POs have no payment date)
      const poExpenditure = await ctx.db.purchaseOrder.aggregate({
        where: { status: "Paid", createdAt: dateFilter },
        _sum: { estimatedTotal: true },
      });

      // Old-style expenses dated within the window
      const oldExpenses = await ctx.db.expenses.aggregate({
        where: { date: dateFilter },
        _sum: { amount: true },
      });

      const totalExpenditure =
        totalSalaries +
        (directExpenses._sum.amount ?? 0) +
        pettyCashSpend +
        (poExpenditure._sum.estimatedTotal ?? 0) +
        (oldExpenses._sum.amount ?? 0);

      const netSurplusDeficit = totalIncome - totalExpenditure;

      return {
        session,
        totalIncome,
        totalExpenditure,
        breakdown: {
          salaries: totalSalaries,
          directExpenses: directExpenses._sum.amount ?? 0,
          pettyCash: pettyCashSpend,
          purchaseOrders: poExpenditure._sum.estimatedTotal ?? 0,
          otherExpenses: oldExpenses._sum.amount ?? 0,
        },
        netSurplusDeficit,
        isDeficit: netSurplusDeficit < 0,
      };
    }),
});
