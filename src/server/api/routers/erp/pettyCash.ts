import { z } from "zod";
import { createTRPCRouter, financeProcedure } from "../../trpc";
import { TRPCError } from "@trpc/server";
import { getSessionEmployee } from "~/server/utils/credential-generator";

export const pettyCashRouter = createTRPCRouter({
  // FR-ERP-30: Initialize petty cash register for a session
  initRegister: financeProcedure
    .input(
      z.object({
        sessionId: z.string().cuid(),
        openingBalance: z.number().positive(),
        minimumBalance: z.number().min(0).default(5000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.pettyCashRegister.findUnique({
        where: { sessionId: input.sessionId },
      });
      if (existing) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Petty cash register already exists for this session",
        });
      }
      return ctx.db.pettyCashRegister.create({
        data: {
          sessionId: input.sessionId,
          openingBalance: input.openingBalance,
          currentBalance: input.openingBalance,
          minimumBalance: input.minimumBalance,
        },
      });
    }),

  // FR-ERP-31: Record disbursement
  recordDisbursement: financeProcedure
    .input(
      z.object({
        sessionId: z.string().cuid(),
        amount: z.number().positive(),
        payee: z.string().min(1),
        purpose: z.string().min(1),
        expenseCategory: z.string().min(1),
        costCentreId: z.string().cuid().optional(),
        voucherRef: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const employeeRecord = await getSessionEmployee(ctx);
      if (!employeeRecord)
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Employee not found",
        });

      const register = await ctx.db.pettyCashRegister.findUnique({
        where: { sessionId: input.sessionId },
      });
      if (!register)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Petty cash register not found",
        });
      if (register.currentBalance < input.amount) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Insufficient petty cash. Available: ${register.currentBalance}, Requested: ${input.amount}`,
        });
      }

      const newBalance = await ctx.db.$transaction(async (tx) => {
        // Conditional decrement: only succeeds if the balance still covers the amount,
        // so two disbursements at once cannot overdraw the register.
        const debited = await tx.pettyCashRegister.updateMany({
          where: {
            registerId: register.registerId,
            currentBalance: { gte: input.amount },
          },
          data: { currentBalance: { decrement: input.amount } },
        });
        if (debited.count === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Insufficient petty cash: the balance changed while this was being recorded. Refresh and try again.",
          });
        }
        await tx.pettyCashDisbursement.create({
          data: {
            registerId: register.registerId,
            amount: input.amount,
            payee: input.payee,
            purpose: input.purpose,
            expenseCategory: input.expenseCategory,
            costCentreId: input.costCentreId,
            voucherRef: input.voucherRef,
            recordedBy: employeeRecord.employeeId,
          },
        });
        const after = await tx.pettyCashRegister.findUniqueOrThrow({
          where: { registerId: register.registerId },
          select: { currentBalance: true },
        });
        return after.currentBalance;
      });

      return { success: true, newBalance };
    }),

  // FR-ERP-32: Replenishment
  recordReplenishment: financeProcedure
    .input(
      z.object({
        sessionId: z.string().cuid(),
        amount: z.number().positive(),
        reference: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const register = await ctx.db.pettyCashRegister.findUnique({
        where: { sessionId: input.sessionId },
      });
      if (!register)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Petty cash register not found",
        });

      const updated = await ctx.db.pettyCashRegister.update({
        where: { registerId: register.registerId },
        data: { currentBalance: { increment: input.amount } },
        select: { currentBalance: true },
      });

      return { success: true, newBalance: updated.currentBalance };
    }),

  // FR-ERP-33: Reconciliation
  recordReconciliation: financeProcedure
    .input(
      z.object({
        sessionId: z.string().cuid(),
        physicalCount: z.number().min(0),
        explanation: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const employeeRecord = await getSessionEmployee(ctx);
      if (!employeeRecord)
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Employee not found",
        });

      const register = await ctx.db.pettyCashRegister.findUnique({
        where: { sessionId: input.sessionId },
      });
      if (!register)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Register not found",
        });

      const variance = input.physicalCount - register.currentBalance;

      await ctx.db.$transaction([
        ctx.db.pettyCashReconciliation.create({
          data: {
            registerId: register.registerId,
            systemBalance: register.currentBalance,
            physicalCount: input.physicalCount,
            variance,
            explanation: input.explanation,
            performedBy: employeeRecord.employeeId,
          },
        }),
        ctx.db.pettyCashRegister.update({
          where: { registerId: register.registerId },
          data: { currentBalance: input.physicalCount },
        }),
      ]);

      return { success: true, variance };
    }),

  getRegister: financeProcedure
    .input(z.object({ sessionId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const register = await ctx.db.pettyCashRegister.findUnique({
        where: { sessionId: input.sessionId },
        include: {
          Disbursements: {
            include: { RecordedBy: { select: { employeeName: true } } },
            orderBy: { date: "desc" },
          },
          Reconciliations: {
            include: { PerformedBy: { select: { employeeName: true } } },
            orderBy: { performedAt: "desc" },
          },
        },
      });

      if (!register) return null;

      const needsReplenishment =
        register.currentBalance <= register.minimumBalance;
      return { ...register, needsReplenishment };
    }),
});
