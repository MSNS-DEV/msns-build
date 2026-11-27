/**
 * Bulk Salary Creation Router — v2.0
 * Implements FR-SAL-01 through FR-SAL-10
 * Extends existing salary.ts (preserved unchanged)
 */
import { z } from "zod";
import { createTRPCRouter, financeProcedure } from "../trpc";
import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";
import { getSessionEmployee } from "~/server/utils/credential-generator";

const bulkSalaryItemSchema = z.object({
  employeeId: z.string().cuid(),
  newSalary: z.number().positive("Salary must be positive"),
  isOverridden: z.boolean().default(false),
});

export const bulkSalaryRouter = createTRPCRouter({
  // FR-SAL-01/FR-SAL-02: Preview bulk salary creation grid
  previewBulkCreation: financeProcedure
    .input(
      z.object({
        toSessionId: z.string().cuid(),
        fromSessionId: z.string().cuid().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Get all active employees
      const employees = await ctx.db.employees.findMany({
        where: {
          designation: { notIn: ["NONE", "STUDENT", "ALL"] },
        },
        select: {
          employeeId: true,
          employeeName: true,
          designation: true,
          admissionNumber: true,
        },
        orderBy: { employeeName: "asc" },
      });

      // Check existing assignments for the target session
      const existingAssignments = await ctx.db.salaryAssignment.findMany({
        where: { sessionId: input.toSessionId },
        select: { employeeId: true, baseSalary: true, totalSalary: true },
      });
      const existingMap = new Map(
        existingAssignments.map((a) => [a.employeeId, a]),
      );

      // If copyFromSession, get previous session assignments
      let prevAssignmentMap = new Map<
        string,
        { baseSalary: number; totalSalary: number }
      >();
      if (input.fromSessionId) {
        const prevAssignments = await ctx.db.salaryAssignment.findMany({
          where: { sessionId: input.fromSessionId },
          select: { employeeId: true, baseSalary: true, totalSalary: true },
        });
        prevAssignmentMap = new Map(
          prevAssignments.map((a) => [a.employeeId, a]),
        );
      }

      const rows = employees.map((emp) => {
        const hasExisting = existingMap.has(emp.employeeId);
        const prevAssignment = prevAssignmentMap.get(emp.employeeId);

        return {
          employeeId: emp.employeeId,
          employeeName: emp.employeeName,
          designation: emp.designation,
          previousSalary: prevAssignment?.totalSalary ?? 0,
          suggestedNewSalary: prevAssignment?.totalSalary ?? 0,
          hasExistingAssignment: hasExisting,
          existingSalary: existingMap.get(emp.employeeId)?.totalSalary ?? null,
          needsManualEntry: !prevAssignment && !hasExisting,
        };
      });

      return {
        rows,
        totalEmployees: employees.length,
        withPreviousSalary: rows.filter((r) => r.previousSalary > 0).length,
        needingManualEntry: rows.filter((r) => r.needsManualEntry).length,
      };
    }),

  // FR-SAL-03/FR-SAL-04: Apply global increment and preview
  applyGlobalIncrement: financeProcedure
    .input(
      z.object({
        items: z.array(
          z.object({ employeeId: z.string(), currentSalary: z.number() }),
        ),
        incrementType: z.enum(["PERCENT", "FIXED"]),
        incrementValue: z.number().min(0),
      }),
    )
    .query(({ input }) => {
      // Pure computation — no DB write
      return input.items.map((item) => {
        let increment = 0;
        if (input.incrementType === "PERCENT") {
          increment = (item.currentSalary * input.incrementValue) / 100;
        } else {
          increment = input.incrementValue;
        }
        return {
          employeeId: item.employeeId,
          previousSalary: item.currentSalary,
          increment,
          newSalary: item.currentSalary + increment,
        };
      });
    }),

  // FR-SAL-06: Execute bulk salary creation (single Prisma transaction)
  executeBulkCreation: financeProcedure
    .input(
      z.object({
        toSessionId: z.string().cuid(),
        fromSessionId: z.string().cuid().optional(),
        globalIncrementType: z.enum(["PERCENT", "FIXED"]).optional(),
        globalIncrementValue: z.number().min(0).default(0),
        items: z.array(bulkSalaryItemSchema).min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const initiatorEmployee = await getSessionEmployee(ctx);
      if (!initiatorEmployee) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Employee record not found",
        });
      }

      // FR-SAL-07: Validate all items before transaction
      const validationErrors: string[] = [];
      const invalid = input.items.filter((item) => item.newSalary <= 0);
      if (invalid.length > 0) {
        const names = await ctx.db.employees.findMany({
          where: { employeeId: { in: invalid.map((i) => i.employeeId) } },
          select: { employeeId: true, employeeName: true },
        });
        const nameById = new Map(
          names.map((n) => [n.employeeId, n.employeeName]),
        );
        for (const item of invalid) {
          validationErrors.push(
            `${nameById.get(item.employeeId) ?? item.employeeId}: Salary must be positive`,
          );
        }
      }

      if (validationErrors.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Validation failed:\n${validationErrors.join("\n")}`,
        });
      }

      // FR-SAL-06: Execute in a single Prisma transaction
      const result = await ctx.db.$transaction(
        async (tx) => {
          // Create the batch record
          const batch = await tx.bulkSalaryCreationBatch.create({
            data: {
              initiatedBy: initiatorEmployee.employeeId,
              fromSessionId: input.fromSessionId,
              toSessionId: input.toSessionId,
              globalIncrementType: input.globalIncrementType,
              globalIncrementValue: input.globalIncrementValue,
              totalEmployees: input.items.length,
            },
          });

          // Get previous salary amounts for the batch items
          const prevAssignments = input.fromSessionId
            ? await tx.salaryAssignment.findMany({
                where: { sessionId: input.fromSessionId },
                select: { employeeId: true, totalSalary: true },
              })
            : [];
          const prevMap = new Map(
            prevAssignments.map((a) => [a.employeeId, a.totalSalary]),
          );

          // Skip employees who already have an assignment in the target session.
          const existing = await tx.salaryAssignment.findMany({
            where: {
              sessionId: input.toSessionId,
              employeeId: { in: input.items.map((i) => i.employeeId) },
            },
            select: { employeeId: true },
          });
          const already = new Set(existing.map((e) => e.employeeId));
          const seen = new Set<string>();
          const toCreate = input.items.filter((i) => {
            if (already.has(i.employeeId) || seen.has(i.employeeId))
              return false;
            seen.add(i.employeeId);
            return true;
          });

          await tx.salaryAssignment.createMany({
            data: toCreate.map((item) => ({
              employeeId: item.employeeId,
              baseSalary: item.newSalary,
              increment: 0,
              totalSalary: item.newSalary,
              sessionId: input.toSessionId,
            })),
          });
          await tx.bulkSalaryCreationItem.createMany({
            data: toCreate.map((item) => ({
              batchId: batch.batchId,
              employeeId: item.employeeId,
              previousSalary: prevMap.get(item.employeeId) ?? 0,
              newSalary: item.newSalary,
              isOverridden: item.isOverridden,
            })),
          });
          const createdCount = toCreate.length;

          await tx.bulkSalaryCreationBatch.update({
            where: { batchId: batch.batchId },
            data: { totalCreated: createdCount },
          });

          return { batchId: batch.batchId, createdCount };
        },
        { timeout: 30_000 },
      );

      return {
        success: true,
        batchId: result.batchId,
        createdCount: result.createdCount,
        totalRequested: input.items.length,
      };
    }),

  // FR-SAL-08: Get batch summary report
  getBatchReport: financeProcedure
    .input(z.object({ batchId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      return ctx.db.bulkSalaryCreationBatch.findUnique({
        where: { batchId: input.batchId },
        include: {
          InitiatedBy: { select: { employeeName: true } },
          ToSession: { select: { sessionName: true } },
          Items: {
            include: {
              Employee: { select: { employeeName: true, designation: true } },
            },
          },
        },
      });
    }),

  // FR-SAL-09/FR-SAL-10: Batch increment for a group of employees
  batchIncrement: financeProcedure
    .input(
      z.object({
        sessionId: z.string().cuid(),
        employeeIds: z.array(z.string().cuid()).min(1),
        incrementType: z.enum(["PERCENT", "FIXED"]),
        incrementValue: z.number().positive(),
        effectiveDate: z.date(),
        rationale: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Latest assignment per employee in the session.
      const assignments = await ctx.db.salaryAssignment.findMany({
        where: {
          sessionId: input.sessionId,
          employeeId: { in: input.employeeIds },
        },
        orderBy: [{ employeeId: "asc" }, { assignedDate: "desc" }],
        distinct: ["employeeId"],
        select: { id: true },
      });

      if (assignments.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message:
            "No salary assignments found for the selected employees in this session",
        });
      }

      const ids = assignments.map((a) => a.id);
      await ctx.db.$transaction(async (tx) => {
        // Computed from the row's current value inside one UPDATE, so concurrent
        // increments both apply instead of one overwriting the other.
        const updated =
          input.incrementType === "PERCENT"
            ? await tx.$queryRaw<{ employeeId: string; delta: number }[]>`
                UPDATE "SalaryAssignment"
                SET "increment" = "increment" + "totalSalary" * ${input.incrementValue} / 100.0,
                    "totalSalary" = "totalSalary" * (1 + ${input.incrementValue} / 100.0)
                WHERE "id" IN (${Prisma.join(ids)})
                RETURNING "employeeId", ("totalSalary" - "totalSalary" / (1 + ${input.incrementValue} / 100.0)) AS "delta"`
            : await tx.$queryRaw<{ employeeId: string; delta: number }[]>`
                UPDATE "SalaryAssignment"
                SET "increment" = "increment" + ${input.incrementValue},
                    "totalSalary" = "totalSalary" + ${input.incrementValue}
                WHERE "id" IN (${Prisma.join(ids)})
                RETURNING "employeeId", ${input.incrementValue}::double precision AS "delta"`;

        await tx.salaryIncrement.createMany({
          data: updated.map((u) => ({
            employeeId: u.employeeId,
            incrementAmount: Math.round(Number(u.delta) * 100) / 100,
            reason: input.rationale,
            effectiveDate: input.effectiveDate,
          })),
        });
      });

      return {
        success: true,
        updatedCount: assignments.length,
        message: `Applied ${input.incrementType === "PERCENT" ? `${input.incrementValue}%` : `PKR ${input.incrementValue}`} increment to ${assignments.length} employees`,
      };
    }),
});
