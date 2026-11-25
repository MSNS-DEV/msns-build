import { z } from "zod";
import { assertNoPaidSalaries } from "~/server/utils/financial-guards";
import { assertCanReadEmployee, isOffice } from "~/server/api/access";
import {
  createTRPCRouter,
  managementProcedure,
  employeeProcedure,
  financeProcedure,
} from "../trpc";
import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";

// ====================== Schemas ======================

const salaryAssignmentSchema = z.object({
  employeeId: z.string().min(1, "Employee ID is required"),
  baseSalary: z.number().min(1000, "Base salary must be at least 1000 PKR"),
  increment: z.number().min(0, "Increment cannot be negative"),
  sessionId: z.string().min(1, "Session ID is required"),
});

const salaryAssignmentUpdateSchema = z.object({
  id: z.string(),
  baseSalary: z.number().min(1000).optional(),
  increment: z.number().min(0).optional(),
  sessionId: z.string().min(1).optional(),
});

const salaryIncrementSchema = z.object({
  employeeId: z.string().min(1, "Employee ID is required"),
  incrementAmount: z.number().positive("Increment amount must be positive"),
  reason: z.string().min(1, "Reason is required"),
  effectiveDate: z.string().transform((str) => new Date(str)),
});

const getSalariesInputSchema = z.object({
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  searchTerm: z.string().optional(),
  sortField: z
    .enum(["employeeName", "baseSalary", "totalSalary", "assignedDate"])
    .optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

const bulkPaySchema = z.object({
  salaryIds: z.array(z.string()).min(1, "At least one salary ID required"),
  paymentDate: z.date().optional(),
});

const bulkDeleteSchema = z.object({
  ids: z.array(z.string()).min(1, "At least one ID required"),
});

const generateMonthlySalariesSchema = z.object({
  month: z.number().min(1).max(12),
  year: z.number(),
  sessionId: z.string().min(1),
});

const salaryCreateSchema = z.object({
  employeeId: z.string().min(1),
  amount: z.number().min(0),
  month: z.number().min(1).max(12),
  year: z.number(),
  status: z.enum(["PAID", "PENDING", "PARTIAL"]),
  paymentDate: z.date().optional(),
  deductions: z.number().min(0).default(0),
  allowances: z.number().min(0).default(0),
  bonus: z.number().min(0).default(0),
  sessionId: z.string().min(1),
});

const salaryUpdateSchema = z.object({
  id: z.string(),
  status: z.enum(["PAID", "PENDING", "PARTIAL"]).optional(),
  amount: z.number().min(0).optional(),
  deductions: z.number().min(0).optional(),
  allowances: z.number().min(0).optional(),
  bonus: z.number().min(0).optional(),
  paymentDate: z.date().optional(),
});

/** Net pay as shown on the salary slip. */
const netPay = (s: {
  amount: number | null;
  allowances: number | null;
  bonus: number | null;
  deductions: number | null;
}) =>
  (s.amount ?? 0) + (s.allowances ?? 0) + (s.bonus ?? 0) - (s.deductions ?? 0);

const isUniqueViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

// ====================== Router ======================

export const salaryRouter = createTRPCRouter({
  // ----------------------------------------------------------------
  // Monthly Salary Records (The "Salary" Model) - PAYROLL
  // ----------------------------------------------------------------

  create: managementProcedure
    .input(salaryCreateSchema)
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.salary.findFirst({
        where: {
          employeeId: input.employeeId,
          month: input.month,
          year: input.year,
        },
      });

      if (existing) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Salary record already exists for this month",
        });
      }

      // --- AUTO-FILL LOGIC START ---
      let finalAmount = input.amount;

      // If amount is 0, try to find the assigned salary for this employee
      if (finalAmount === 0) {
        const assignment = await ctx.db.salaryAssignment.findFirst({
          where: {
            employeeId: input.employeeId,
            sessionId: input.sessionId,
          },
          orderBy: { assignedDate: "desc" },
        });

        if (assignment) {
          finalAmount = assignment.totalSalary;
        }
      }
      // --- AUTO-FILL LOGIC END ---

      try {
        return await ctx.db.salary.create({
          data: {
            employeeId: input.employeeId,
            amount: finalAmount,
            month: input.month,
            year: input.year,
            status: input.status,
            // Only a paid salary has a payment date.
            paymentDate:
              input.status === "PAID"
                ? (input.paymentDate ?? new Date())
                : input.paymentDate,
            deductions: input.deductions,
            allowances: input.allowances,
            bonus: input.bonus,
            sessionId: input.sessionId,
          },
        });
      } catch (e) {
        // Two submissions at once: the unique (employee, month, year) key rejects the second.
        if (isUniqueViolation(e)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Salary record already exists for this month",
          });
        }
        throw e;
      }
    }),

  update: managementProcedure
    .input(salaryUpdateSchema)
    .mutation(async ({ ctx, input }) => {
      return ctx.db.salary.update({
        where: { id: input.id },
        data: {
          status: input.status,
          amount: input.amount,
          deductions: input.deductions,
          allowances: input.allowances,
          bonus: input.bonus,
          paymentDate: input.paymentDate,
        },
      });
    }),

  delete: managementProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await assertNoPaidSalaries(
        ctx.db,
        { id: input.id },
        "delete this salary",
      );
      return ctx.db.salary.delete({ where: { id: input.id } });
    }),

  // Used for Payroll Table Bulk Delete
  bulkDelete: managementProcedure
    .input(bulkDeleteSchema)
    .mutation(async ({ ctx, input }) => {
      await assertNoPaidSalaries(
        ctx.db,
        { id: { in: input.ids } },
        "delete these salaries",
      );
      return ctx.db.salary.deleteMany({
        where: {
          id: { in: input.ids },
        },
      });
    }),

  getAll: financeProcedure
    .input(
      z.object({
        sessionId: z.string().optional(),
        month: z.number().optional(),
        year: z.number().optional(),
        employeeId: z.string().optional(),
        status: z.enum(["PAID", "PENDING", "PARTIAL"]).optional(),
        limit: z.number().default(50),
        cursor: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const where: Prisma.SalaryWhereInput = {};
      if (input.sessionId) where.sessionId = input.sessionId;
      if (input.month) where.month = input.month;
      if (input.year) where.year = input.year;
      if (input.employeeId) where.employeeId = input.employeeId;
      if (input.status) where.status = input.status;

      const salaries = await ctx.db.salary.findMany({
        where,
        take: input.limit + 1,
        cursor: input.cursor ? { id: input.cursor } : undefined,
        // id breaks ties so cursor pages never repeat or skip rows (paymentDate is often null).
        orderBy: [
          { paymentDate: { sort: "desc", nulls: "last" } },
          { id: "desc" },
        ],
        include: { Employees: true },
      });

      let nextCursor: string | undefined = undefined;
      if (salaries.length > input.limit) {
        const nextItem = salaries.pop();
        nextCursor = nextItem?.id;
      }

      return { salaries, nextCursor };
    }),

  getPendingSalaries: financeProcedure
    .input(
      z.object({ month: z.number(), year: z.number(), sessionId: z.string() }),
    )
    .query(async ({ ctx, input }) => {
      return ctx.db.salary.findMany({
        where: {
          month: input.month,
          year: input.year,
          sessionId: input.sessionId,
          status: { in: ["PENDING", "PARTIAL"] },
        },
        include: { Employees: true },
      });
    }),

  bulkPaySalaries: managementProcedure
    .input(bulkPaySchema)
    .mutation(async ({ ctx, input }) => {
      const paymentDate = input.paymentDate ?? new Date();

      const updated = await ctx.db.salary.updateMany({
        where: { id: { in: input.salaryIds } },
        data: { status: "PAID", paymentDate },
      });

      return { updatedCount: updated.count };
    }),

  generateMonthlySalaries: managementProcedure
    .input(generateMonthlySalariesSchema)
    .mutation(async ({ ctx, input }) => {
      const { month, year, sessionId } = input;

      // Latest assignment per employee (an increment adds a newer row), active staff only.
      const assignments = await ctx.db.salaryAssignment.findMany({
        where: { sessionId, Employees: { status: "Active" } },
        orderBy: [{ employeeId: "asc" }, { assignedDate: "desc" }],
        distinct: ["employeeId"],
        select: { employeeId: true, totalSalary: true },
      });

      const created = await ctx.db.salary.createMany({
        data: assignments.map((a) => ({
          employeeId: a.employeeId,
          amount: a.totalSalary || 0,
          month,
          year,
          status: "PENDING" as const,
          sessionId,
          deductions: 0,
          allowances: 0,
          bonus: 0,
        })),
        // Existing (employee, month, year) rows are left untouched, so re-running is safe.
        skipDuplicates: true,
      });

      return { generatedCount: created.count };
    }),

  getMonthlyPayouts: financeProcedure
    .input(z.object({ year: z.number(), sessionId: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      const where: Prisma.SalaryWhereInput = {
        year: input.year,
        status: "PAID",
      };
      if (input.sessionId) where.sessionId = input.sessionId;

      const grouped = await ctx.db.salary.groupBy({
        by: ["month"],
        where,
        _sum: { amount: true, allowances: true, bonus: true, deductions: true },
      });

      const monthlyData: number[] = new Array(12).fill(0) as number[];
      for (const g of grouped) {
        const idx = g.month - 1;
        if (idx >= 0 && idx < 12) monthlyData[idx] = netPay(g._sum);
      }

      return monthlyData.map((amount, index) => ({
        month: new Date(2000, index).toLocaleString("en-US", {
          month: "short",
        }),
        amount,
      }));
    }),

  getTotalPayrollCost: financeProcedure
    .input(
      z.object({
        month: z.number().optional(),
        year: z.number(),
        sessionId: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const where: Prisma.SalaryWhereInput = {
        year: input.year,
        status: "PAID",
      };
      if (input.month) where.month = input.month;
      if (input.sessionId) where.sessionId = input.sessionId;

      const result = await ctx.db.salary.aggregate({
        where,
        _sum: { amount: true, allowances: true, bonus: true, deductions: true },
      });

      return { totalPayroll: netPay(result._sum) };
    }),

  getUnpaidEmployees: financeProcedure
    .input(
      z.object({ month: z.number(), year: z.number(), sessionId: z.string() }),
    )
    .query(async ({ ctx, input }) => {
      const allEmployees = await ctx.db.employees.findMany({
        where: { designation: { not: "NONE" }, status: "Active" },
      });

      // Only a PAID salary counts; a generated PENDING row is still unpaid.
      const paidSalaries = await ctx.db.salary.findMany({
        where: {
          month: input.month,
          year: input.year,
          sessionId: input.sessionId,
          status: "PAID",
        },
        select: { employeeId: true },
      });

      const paidIds = new Set(paidSalaries.map((s) => s.employeeId));
      return allEmployees.filter((emp) => !paidIds.has(emp.employeeId));
    }),

  getEmployeeSalarySummary: employeeProcedure
    .input(
      z.object({
        employeeId: z.string(),
        year: z.number().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await assertCanReadEmployee(ctx, input.employeeId);
      const where: Prisma.SalaryWhereInput = {
        employeeId: input.employeeId,
      };
      if (input.year) where.year = input.year;

      const salaries = await ctx.db.salary.findMany({
        where,
        orderBy: { year: "desc" },
      });

      const totalPaid = salaries
        .filter((s) => s.status === "PAID")
        .reduce(
          (sum, s) =>
            sum +
            s.amount +
            (s.allowances ?? 0) +
            (s.bonus ?? 0) -
            (s.deductions ?? 0),
          0,
        );

      return { records: salaries, totalPaid };
    }),

  getSalarySlipData: employeeProcedure
    .input(
      z.object({
        salaryId: z.string().optional(),
        employeeId: z.string().optional(),
        month: z.number().optional(),
        year: z.number().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      if (!isOffice(ctx)) {
        const slipOwner = input.salaryId
          ? (
              await ctx.db.salary.findUnique({
                where: { id: input.salaryId },
                select: { employeeId: true },
              })
            )?.employeeId
          : input.employeeId;
        await assertCanReadEmployee(ctx, slipOwner);
      }
      const where: Prisma.SalaryWhereInput = {};
      if (input.salaryId) {
        where.id = input.salaryId;
      } else if (input.employeeId && input.month && input.year) {
        where.employeeId = input.employeeId;
        where.month = input.month;
        where.year = input.year;
      } else {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Insufficient data",
        });
      }

      const salary = await ctx.db.salary.findFirst({
        where,
        include: { Employees: true },
      });

      if (!salary)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Salary record not found",
        });

      const netPay =
        salary.amount +
        (salary.allowances ?? 0) +
        (salary.bonus ?? 0) -
        (salary.deductions ?? 0);

      return { ...salary, netPay };
    }),

  // ----------------------------------------------------------------
  // Salary Assignments & Increments (The "SalaryAssignment" Model) - STRUCTURES
  // ----------------------------------------------------------------

  // NEW: This fixes the client error in SalaryTable
  deleteSalariesByIds: managementProcedure
    .input(z.object({ ids: z.string().array() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.salaryAssignment.deleteMany({
        where: { id: { in: input.ids } },
      });
    }),

  assignSalary: managementProcedure
    .input(salaryAssignmentSchema)
    .mutation(async ({ ctx, input }) => {
      return ctx.db.salaryAssignment.create({
        data: {
          employeeId: input.employeeId,
          baseSalary: input.baseSalary,
          increment: input.increment,
          sessionId: input.sessionId,
          totalSalary: input.baseSalary + input.increment,
          assignedDate: new Date(),
        },
      });
    }),

  updateSalaryAssignment: managementProcedure
    .input(salaryAssignmentUpdateSchema)
    .mutation(async ({ ctx, input }) => {
      const current = await ctx.db.salaryAssignment.findUnique({
        where: { id: input.id },
      });
      if (!current)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Assignment not found",
        });

      const baseSalary = input.baseSalary ?? current.baseSalary;
      const increment = input.increment ?? current.increment;
      const totalSalary = baseSalary + increment;

      return ctx.db.salaryAssignment.update({
        where: { id: input.id },
        data: {
          baseSalary,
          increment,
          totalSalary,
          sessionId: input.sessionId ?? current.sessionId,
        },
      });
    }),

  deleteSalaryAssignment: managementProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.salaryAssignment.delete({ where: { id: input.id } });
    }),

  deleteBulkSalaryAssignments: managementProcedure
    .input(z.object({ ids: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.salaryAssignment.deleteMany({
        where: { id: { in: input.ids } },
      });
    }),

  getSalaryHistory: employeeProcedure
    .input(z.object({ employeeId: z.string() }))
    .query(async ({ ctx, input }) => {
      await assertCanReadEmployee(ctx, input.employeeId);
      return ctx.db.salaryAssignment.findMany({
        where: { employeeId: input.employeeId },
        orderBy: { assignedDate: "desc" },
      });
    }),

  addSalaryIncrement: managementProcedure
    .input(salaryIncrementSchema)
    .mutation(async ({ ctx, input }) => {
      const currentAssignment = await ctx.db.salaryAssignment.findFirst({
        where: { employeeId: input.employeeId },
        orderBy: { assignedDate: "desc" },
      });

      if (!currentAssignment) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No salary assignment found for this employee",
        });
      }

      // Record and apply together; atomic increments so two submissions both count.
      const [, updated] = await ctx.db.$transaction([
        ctx.db.salaryIncrement.create({
          data: {
            employeeId: input.employeeId,
            incrementAmount: input.incrementAmount,
            reason: input.reason,
            effectiveDate: input.effectiveDate,
          },
        }),
        ctx.db.salaryAssignment.update({
          where: { id: currentAssignment.id },
          data: {
            increment: { increment: input.incrementAmount },
            totalSalary: { increment: input.incrementAmount },
          },
        }),
      ]);
      return updated;
    }),

  getCurrentSalary: employeeProcedure
    .input(z.object({ employeeId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      await assertCanReadEmployee(ctx, input.employeeId);
      const salary = await ctx.db.salaryAssignment.findFirst({
        where: { employeeId: input.employeeId },
        orderBy: { assignedDate: "desc" },
        include: { Sessions: true, Employees: true },
      });

      if (!salary) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No salary assigned",
        });
      }
      return salary;
    }),

  getSalaries: financeProcedure
    .input(getSalariesInputSchema)
    .query(async ({ ctx, input }) => {
      const { page, pageSize, searchTerm, sortField, sortOrder } = input;

      const where: Prisma.SalaryAssignmentWhereInput = {};

      if (searchTerm) {
        where.Employees = {
          employeeName: { contains: searchTerm, mode: "insensitive" },
        };
      }

      let orderBy: Prisma.SalaryAssignmentOrderByWithRelationInput = {
        assignedDate: "desc",
      };
      if (sortField && sortOrder) {
        if (sortField === "employeeName") {
          orderBy = { Employees: { employeeName: sortOrder } };
        } else {
          orderBy = { [sortField]: sortOrder };
        }
      }

      let latestAssignments: { id: string }[];

      if (searchTerm) {
        latestAssignments = await ctx.db.$queryRaw`
          SELECT DISTINCT ON ("employeeId") id
          FROM "SalaryAssignment"
          WHERE "employeeId" IN (
            SELECT "employeeId" FROM "Employees" WHERE "employeeName" ILIKE ${"%" + searchTerm + "%"}
          )
          ORDER BY "employeeId", "assignedDate" DESC
        `;
      } else {
        latestAssignments = await ctx.db.$queryRaw`
          SELECT DISTINCT ON ("employeeId") id
          FROM "SalaryAssignment"
          ORDER BY "employeeId", "assignedDate" DESC
        `;
      }

      const latestIds = latestAssignments.map((a) => a.id);
      const filteredWhere: Prisma.SalaryAssignmentWhereInput = {
        id: { in: latestIds },
      };

      const [salaries, totalCount] = await Promise.all([
        ctx.db.salaryAssignment.findMany({
          where: filteredWhere,
          take: pageSize,
          skip: (page - 1) * pageSize,
          orderBy,
          include: { Employees: true, Sessions: true },
        }),
        ctx.db.salaryAssignment.count({
          where: filteredWhere,
        }),
      ]);

      return { salaries, totalCount };
    }),
});
