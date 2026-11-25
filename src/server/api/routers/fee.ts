import { z } from "zod";
import { after } from "next/server";
import { assertCanReadStudent } from "~/server/api/access";
import { TRPCError } from "@trpc/server";
import { type Prisma } from "@prisma/client";
import { createTRPCRouter, protectedProcedure, clerkProcedure, financeProcedure, officeProcedure } from "~/server/api/trpc";
import { computeFeeRows, sumAmounts } from "~/lib/fee-calc";

// --- Input Schemas ---

const money = z.number().finite().min(0);

const feeInputSchema = z.object({
  level: z.string(),
  admissionFee: money,
  tuitionFee: money,
  examFund: money,
  computerLabFund: money.optional(),
  studentIdCardFee: money,
  infoAndCallsFee: money,
  type: z.enum(["MonthlyFee", "AnnualFee"]),
});

const feeUpdateSchema = feeInputSchema.partial().extend({
  feeId: z.string(),
});

const paymentUpdateSchema = z.object({
  feeStudentClassId: z.string(),
  tuitionPaid: z.boolean().optional(),
  examFundPaid: z.boolean().optional(),
  computerLabPaid: z.boolean().optional(),
  studentIdCardPaid: z.boolean().optional(),
  infoAndCallsPaid: z.boolean().optional(),
  admissionFeePaid: z.boolean().optional(),
  paidAt: z.date().optional(),
  discount: money.optional(),
  discountbypercent: z.number().finite().min(0).max(100).optional(),
  discountDescription: z.string().max(500).optional(),
});

// --- Helper Types for Aggregation ---
interface MonthlyFeeStats {
  month: string;
  monthNumber: number;
  totalExpected: number;
  totalCollected: number;
  outstanding: number;
  paidCount: number;
  unpaidCount: number;
  collectionRate: number;
}

interface ClassFeeGroup {
  className: string;
  studentCount: number;
  totalExpected: number;
  totalPaid: number;
  payments: {
    isPaid: boolean;
    studentId: string;
    amount: number;
  }[];
}

// --- Helpers ---

/** True when any money has been recorded against the voucher. */
const isVoucherPaid = (f: {
  tuitionPaid: boolean;
  examFundPaid: boolean;
  computerLabPaid: boolean;
  studentIdCardPaid: boolean;
  infoAndCallsPaid: boolean;
  admissionFeePaid: boolean;
  paidAt: Date | null;
  amountPaid: number;
}) =>
  f.tuitionPaid ||
  f.examFundPaid ||
  f.computerLabPaid ||
  f.studentIdCardPaid ||
  f.infoAndCallsPaid ||
  f.admissionFeePaid ||
  f.paidAt !== null ||
  f.amountPaid > 0;

const PAID_VOUCHER_WHERE: Prisma.FeeStudentClassWhereInput = {
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

const ANNUAL_FLAGS = [
  "examFundPaid",
  "computerLabPaid",
  "studentIdCardPaid",
  "infoAndCallsPaid",
] as const;

const monthName = (i: number, style: "long" | "short") =>
  new Date(2000, i, 1).toLocaleString("en-US", { month: style });

export const feeRouter = createTRPCRouter({
  // --- CRUD Operations ---

  createFee: clerkProcedure
    .input(feeInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.fees.create({ data: input });
      } catch (error) {
        console.error("createFee failed:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create fee",
        });
      }
    }),

  updateFee: clerkProcedure
    .input(feeUpdateSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const { feeId, ...updateData } = input;
        return await ctx.db.fees.update({
          where: { feeId },
          data: updateData,
        });
      } catch (error) {
        console.error("updateFee failed:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to update fee",
        });
      }
    }),

  /**
   * Deletes fee structures and their unpaid vouchers. Refuses when any voucher using
   * them has a payment recorded, so collection history is never erased.
   */
  deleteFeesByIds: clerkProcedure
    .input(z.object({ feeIds: z.array(z.string()).min(1) }))
    .mutation(async ({ ctx, input }) => {
      const paidCount = await ctx.db.feeStudentClass.count({
        where: { feeId: { in: input.feeIds }, ...PAID_VOUCHER_WHERE },
      });
      if (paidCount > 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `${paidCount} voucher(s) using this fee structure have payments recorded. Edit the fee structure instead of deleting it.`,
        });
      }
      await ctx.db.$transaction(async (tx) => {
        await tx.feeStudentClass.deleteMany({
          where: { feeId: { in: input.feeIds } },
        });
        await tx.fees.deleteMany({
          where: { feeId: { in: input.feeIds } },
        });
      });
      return { success: true };
    }),

  getAllFees: officeProcedure.query(async ({ ctx }) => {
    return await ctx.db.fees.findMany({ orderBy: { level: "asc" } });
  }),

  assignFeeToClass: clerkProcedure
    .input(
      z.object({
        feeId: z.string(),
        classId: z.string(),
        sessionId: z.string(),
        month: z.number().int().min(1).max(12),
        year: z.number().int().min(2000).max(2100),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const studentClasses = await ctx.db.studentClass.findMany({
        where: { classId: input.classId, sessionId: input.sessionId },
        select: { scId: true, studentId: true },
      });
      if (studentClasses.length === 0) return { assignedCount: 0, skippedCount: 0 };

      const existing = await ctx.db.feeStudentClass.findMany({
        where: {
          studentClassId: { in: studentClasses.map((sc) => sc.scId) },
          feeId: input.feeId,
          month: input.month,
          year: input.year,
        },
        select: { studentClassId: true },
      });
      const already = new Set(existing.map((e) => e.studentClassId));
      const toCreate = studentClasses.filter((sc) => !already.has(sc.scId));

      // skipDuplicates makes concurrent runs safe: the unique key rejects a second copy.
      const created = await ctx.db.feeStudentClass.createMany({
        data: toCreate.map((sc) => ({
          studentClassId: sc.scId,
          feeId: input.feeId,
          month: input.month,
          year: input.year,
          discount: 0,
          discountByPercent: 0,
          discountDescription: "",
          lateFee: 0,
        })),
        skipDuplicates: true,
      });

      // Notify parents of newly assigned students only, after the response is sent.
      const newStudentIds = toCreate.map((sc) => sc.studentId);
      if (newStudentIds.length > 0) {
        const db = ctx.db;
        after(async () => {
          try {
            const [parents, feeRecord, students] = await Promise.all([
              db.parentGuardian.findMany({
                where: { linkedStudentIds: { hasSome: newStudentIds } },
                select: { guardentId: true, linkedStudentIds: true },
              }),
              db.fees.findUnique({
                where: { feeId: input.feeId },
                select: { type: true },
              }),
              db.students.findMany({
                where: { studentId: { in: newStudentIds } },
                select: { studentId: true, studentName: true },
              }),
            ]);
            const nameById = new Map(students.map((s) => [s.studentId, s.studentName]));
            const feeType = feeRecord?.type === "MonthlyFee" ? "Monthly Fee" : "Annual Fee";
            const { sendPushNotification } = await import("~/server/mobile/fcm");
            for (const parent of parents) {
              const childId = parent.linkedStudentIds.find((id) => nameById.has(id));
              const name = (childId && nameById.get(childId)) ?? "Student";
              await sendPushNotification(
                [],
                [parent.guardentId],
                "Fee Due Notification",
                `Dear Parent, the ${feeType} for ${name} is due for ${input.month}/${input.year}.`,
              );
            }
          } catch (err) {
            console.error("Failed to send fee due push notification:", err);
          }
        });
      }

      return {
        assignedCount: created.count,
        skippedCount: studentClasses.length - created.count,
      };
    }),

  /**
   * Updates one voucher's payment flags and discount.
   *
   * Annual components (exam, lab, ID card, info) are charged once per student per year.
   * Marking one paid records it on the student's AnnualFee voucher for that year when one
   * exists, otherwise on this voucher; marking it unpaid clears it on every voucher of that
   * student-year. Nothing is copied across months any more.
   */
  updateFeePayment: clerkProcedure
    .input(paymentUpdateSchema)
    .mutation(async ({ ctx, input }) => {
      const { feeStudentClassId, discountbypercent, paidAt, ...rest } = input;

      return ctx.db.$transaction(async (tx) => {
        const current = await tx.feeStudentClass.findUnique({
          where: { sfcId: feeStudentClassId },
          include: { fees: { select: { type: true } } },
        });
        if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Voucher not found" });

        const annualSet: Partial<Record<(typeof ANNUAL_FLAGS)[number], true>> = {};
        const annualClear: Partial<Record<(typeof ANNUAL_FLAGS)[number], false>> = {};
        for (const k of ANNUAL_FLAGS) {
          if (rest[k] === true) annualSet[k] = true;
          if (rest[k] === false) annualClear[k] = false;
        }

        // Where annual components are recorded for this student-year.
        let annualTargetId = current.sfcId;
        if (current.fees.type !== "AnnualFee" && Object.keys(annualSet).length > 0) {
          const annualVoucher = await tx.feeStudentClass.findFirst({
            where: {
              studentClassId: current.studentClassId,
              year: current.year,
              fees: { type: "AnnualFee" },
              isSplitLocked: false,
              paymentStatus: { notIn: ["CANCELLED", "LOCKED_MERGED"] },
            },
            select: { sfcId: true },
          });
          if (annualVoucher) annualTargetId = annualVoucher.sfcId;
        }

        const ownData: Prisma.FeeStudentClassUpdateInput = {
          ...(rest.tuitionPaid !== undefined ? { tuitionPaid: rest.tuitionPaid } : {}),
          ...(rest.admissionFeePaid !== undefined ? { admissionFeePaid: rest.admissionFeePaid } : {}),
          ...(rest.discount !== undefined ? { discount: rest.discount } : {}),
          ...(rest.discountDescription !== undefined
            ? { discountDescription: rest.discountDescription }
            : {}),
          ...(discountbypercent !== undefined ? { discountByPercent: discountbypercent } : {}),
          ...annualClear,
          ...(annualTargetId === current.sfcId ? annualSet : {}),
        };
        await tx.feeStudentClass.update({ where: { sfcId: current.sfcId }, data: ownData });

        if (annualTargetId !== current.sfcId) {
          await tx.feeStudentClass.update({
            where: { sfcId: annualTargetId },
            data: annualSet,
          });
        }
        if (Object.keys(annualClear).length > 0) {
          await tx.feeStudentClass.updateMany({
            where: { studentClassId: current.studentClassId, year: current.year },
            data: annualClear,
          });
        }

        // Keep paidAt meaningful: set when the first payment lands, cleared when none remain.
        const touched = await tx.feeStudentClass.findMany({
          where: { sfcId: { in: [current.sfcId, annualTargetId] } },
        });
        for (const v of touched) {
          const anyPaid = isVoucherPaid({ ...v, paidAt: null });
          if (anyPaid && v.paidAt === null) {
            await tx.feeStudentClass.update({
              where: { sfcId: v.sfcId },
              data: { paidAt: paidAt ?? new Date() },
            });
          } else if (!anyPaid && v.paidAt !== null) {
            await tx.feeStudentClass.update({
              where: { sfcId: v.sfcId },
              data: { paidAt: null },
            });
          }
        }

        return tx.feeStudentClass.findUniqueOrThrow({ where: { sfcId: current.sfcId } });
      });
    }),

  /**
   * Marks several vouchers paid or unpaid in one transaction. Only the components each
   * voucher charges are touched: tuition for monthly vouchers; annual components and
   * admission for AnnualFee vouchers.
   */
  updateFeePaymentsBatch: clerkProcedure
    .input(
      z.object({
        feeStudentClassIds: z.array(z.string()).min(1).max(500),
        paid: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      return ctx.db.$transaction(async (tx) => {
        const vouchers = await tx.feeStudentClass.findMany({
          where: { sfcId: { in: input.feeStudentClassIds } },
          select: { sfcId: true, paidAt: true, fees: { select: { type: true } } },
        });
        const monthlyIds = vouchers.filter((v) => v.fees.type !== "AnnualFee").map((v) => v.sfcId);
        const annualIds = vouchers.filter((v) => v.fees.type === "AnnualFee").map((v) => v.sfcId);
        const paidAt = input.paid ? now : null;

        if (monthlyIds.length > 0) {
          await tx.feeStudentClass.updateMany({
            where: { sfcId: { in: monthlyIds } },
            data: { tuitionPaid: input.paid },
          });
        }
        if (annualIds.length > 0) {
          await tx.feeStudentClass.updateMany({
            where: { sfcId: { in: annualIds } },
            data: {
              examFundPaid: input.paid,
              computerLabPaid: input.paid,
              studentIdCardPaid: input.paid,
              infoAndCallsPaid: input.paid,
              admissionFeePaid: input.paid,
            },
          });
        }
        await tx.feeStudentClass.updateMany({
          where: {
            sfcId: { in: vouchers.map((v) => v.sfcId) },
            ...(input.paid ? { paidAt: null } : {}),
          },
          data: { paidAt },
        });
        return { updated: vouchers.length };
      });
    }),

  /** Removes an unpaid voucher. Paid vouchers are kept as collection history. */
  removeFeeAssignment: clerkProcedure
    .input(z.object({ feeStudentClassId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const voucher = await ctx.db.feeStudentClass.findUnique({
        where: { sfcId: input.feeStudentClassId },
      });
      if (!voucher) throw new TRPCError({ code: "NOT_FOUND", message: "Voucher not found" });
      if (isVoucherPaid(voucher)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This voucher has a payment recorded and cannot be removed. Mark it unpaid first if the payment was entered by mistake.",
        });
      }
      return ctx.db.feeStudentClass.delete({
        where: { sfcId: input.feeStudentClassId },
      });
    }),

  applyLateFee: clerkProcedure
    .input(z.object({ sfcId: z.string(), lateFeeAmount: money }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.feeStudentClass.update({
          where: { sfcId: input.sfcId },
          data: { lateFee: input.lateFeeAmount },
        });
      } catch (error) {
        console.error("Error applying late fee:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to apply late fee",
        });
      }
    }),

  // --- Queries for Dashboard ---

  getClassFeeSummary: financeProcedure
    .input(z.object({ sessionId: z.string(), year: z.number() }))
    .query(async ({ ctx, input }) => {
      const classes = await ctx.db.grades.findMany({
        orderBy: { category: "asc" },
        include: {
          _count: {
            select: {
              StudentClass: { where: { sessionId: input.sessionId } },
            },
          },
        },
      });

      const feeAssignments = await ctx.db.feeStudentClass.findMany({
        where: {
          year: input.year,
          StudentClass: { sessionId: input.sessionId },
        },
        include: {
          fees: true,
          StudentClass: { select: { classId: true } },
        },
      });
      const amounts = computeFeeRows(feeAssignments);

      const byClass = new Map<string, typeof feeAssignments>();
      for (const f of feeAssignments) {
        const list = byClass.get(f.StudentClass.classId);
        if (list) list.push(f);
        else byClass.set(f.StudentClass.classId, [f]);
      }

      const classData = classes.map((cls) => {
        const classFees = byClass.get(cls.classId) ?? [];
        let totalExpected = 0;
        let totalCollected = 0;

        const monthlyStats: MonthlyFeeStats[] = Array.from(
          { length: 12 },
          (_, i) => ({
            month: monthName(i, "long"),
            monthNumber: i + 1,
            totalExpected: 0,
            totalCollected: 0,
            outstanding: 0,
            paidCount: 0,
            unpaidCount: 0,
            collectionRate: 0,
          }),
        );

        classFees.forEach((f) => {
          const a = amounts.get(f.sfcId);
          if (!a || a.excluded) return;
          totalExpected += a.due;
          totalCollected += a.paid;

          const m = monthlyStats[f.month - 1];
          if (m) {
            m.totalExpected += a.due;
            m.totalCollected += a.paid;
            if (a.due > 0 && a.isPaid) m.paidCount++;
            else if (a.due > 0) m.unpaidCount++;
          }
        });

        monthlyStats.forEach((m) => {
          m.outstanding = m.totalExpected - m.totalCollected;
          m.collectionRate =
            m.totalExpected > 0 ? (m.totalCollected / m.totalExpected) * 100 : 0;
        });

        return {
          classId: cls.classId,
          className: `${cls.grade} - ${cls.section}`,
          category: cls.category,
          studentCount: cls._count.StudentClass,
          collectionRate:
            totalExpected > 0 ? (totalCollected / totalExpected) * 100 : 0,
          yearlyTotals: {
            totalExpected,
            totalCollected,
            outstanding: totalExpected - totalCollected,
          },
          monthlyData: monthlyStats,
        };
      });

      const grandTotals = classData.reduce(
        (acc, curr) => ({
          totalExpected: acc.totalExpected + curr.yearlyTotals.totalExpected,
          totalCollected: acc.totalCollected + curr.yearlyTotals.totalCollected,
          outstanding: acc.outstanding + curr.yearlyTotals.outstanding,
          totalStudents: acc.totalStudents + curr.studentCount,
          collectionRate: 0,
        }),
        {
          totalExpected: 0,
          totalCollected: 0,
          outstanding: 0,
          totalStudents: 0,
          collectionRate: 0,
        },
      );

      grandTotals.collectionRate =
        grandTotals.totalExpected > 0
          ? (grandTotals.totalCollected / grandTotals.totalExpected) * 100
          : 0;

      return { classes: classData, grandTotals };
    }),

  getDefaultersList: financeProcedure
    .input(
      z.object({ sessionId: z.string(), month: z.number(), year: z.number() }),
    )
    .query(async ({ ctx, input }) => {
      // Load the whole year so annual components are attributed once per student.
      const vouchers = await ctx.db.feeStudentClass.findMany({
        where: {
          year: input.year,
          StudentClass: { sessionId: input.sessionId },
        },
        include: {
          fees: true,
          StudentClass: { include: { Students: true, Grades: true } },
        },
      });
      const amounts = computeFeeRows(vouchers);

      return vouchers
        .filter((f) => f.month === input.month)
        .map((f) => {
          const a = amounts.get(f.sfcId);
          if (!a || a.excluded || a.isPaid) return null;
          const unpaid = (k: keyof typeof a.components) =>
            a.components[k] !== undefined && a.paidComponents[k] === undefined;

          return {
            sfcId: f.sfcId,
            student: {
              studentName: f.StudentClass.Students.studentName,
              registrationNumber: f.StudentClass.Students.registrationNumber,
              fatherName: f.StudentClass.Students.fatherName,
              fatherMobile: f.StudentClass.Students.fatherMobile,
              gender: f.StudentClass.Students.gender,
            },
            class: {
              grade: f.StudentClass.Grades.grade,
              section: f.StudentClass.Grades.section,
            },
            dueAmount: a.outstanding,
            unpaidItems: {
              tuition: unpaid("tuition"),
              examFund: unpaid("examFund"),
              computerLab: unpaid("computerLab"),
              studentIdCard: unpaid("studentIdCard"),
              infoAndCalls: unpaid("infoAndCalls"),
              admission: unpaid("admission"),
            },
          };
        })
        .filter((d): d is NonNullable<typeof d> => d !== null);
    }),

  getFeeByEachMonth: financeProcedure
    .input(z.object({ month: z.number(), year: z.number() }))
    .query(async ({ ctx, input }) => {
      const assignments = await ctx.db.feeStudentClass.findMany({
        where: { year: input.year },
        include: { fees: true, StudentClass: { include: { Grades: true } } },
      });
      const amounts = computeFeeRows(assignments);

      const classMap = new Map<string, ClassFeeGroup>();
      let grandExpected = 0;
      let grandCollected = 0;

      assignments
        .filter((f) => f.month === input.month)
        .forEach((f) => {
          const a = amounts.get(f.sfcId);
          if (!a || a.excluded) return;
          const className = `${f.StudentClass.Grades.grade} - ${f.StudentClass.Grades.section}`;
          let entry = classMap.get(className);
          if (!entry) {
            entry = { className, studentCount: 0, totalExpected: 0, totalPaid: 0, payments: [] };
            classMap.set(className, entry);
          }

          entry.totalExpected += a.due;
          entry.totalPaid += a.paid;
          entry.studentCount++;
          entry.payments.push({
            isPaid: a.isPaid,
            studentId: f.StudentClass.studentId,
            amount: a.paid,
          });

          grandExpected += a.due;
          grandCollected += a.paid;
        });

      return {
        grandExpected,
        grandTotal: grandCollected,
        outstanding: grandExpected - grandCollected,
        feesByClass: Array.from(classMap.values()),
      };
    }),

  getFeeAnalytics: financeProcedure
    .input(z.object({ sessionId: z.string(), year: z.number() }))
    .query(async ({ ctx, input }) => {
      const assignments = await ctx.db.feeStudentClass.findMany({
        where: {
          year: input.year,
          StudentClass: { sessionId: input.sessionId },
        },
        include: { fees: true, StudentClass: { include: { Grades: true } } },
      });
      const amounts = computeFeeRows(assignments);

      const monthlyData = new Map<number, { collected: number; expected: number }>();
      const categoryData = new Map<string, number>();

      assignments.forEach((f) => {
        const a = amounts.get(f.sfcId);
        if (!a || a.excluded) return;
        const mStats = monthlyData.get(f.month) ?? { collected: 0, expected: 0 };
        mStats.collected += a.paid;
        mStats.expected += a.due;
        monthlyData.set(f.month, mStats);

        const cat = f.StudentClass.Grades.category;
        categoryData.set(cat, (categoryData.get(cat) ?? 0) + a.paid);
      });
      const totals = sumAmounts(amounts.values());

      const monthlyTrend = Array.from({ length: 12 }, (_, i) => {
        const stats = monthlyData.get(i + 1) ?? { collected: 0, expected: 0 };
        return {
          month: monthName(i, "short"),
          collected: stats.collected,
          outstanding: stats.expected - stats.collected,
        };
      });

      const categoryCollection = Array.from(categoryData.entries()).map(
        ([k, v]) => ({ category: k, collected: v }),
      );

      return {
        summary: {
          collectionRate: totals.due > 0 ? (totals.paid / totals.due) * 100 : 0,
          totalDiscounts: totals.discount,
          totalLateFees: totals.lateFee,
          totalOutstanding: totals.outstanding,
        },
        monthlyTrend,
        categoryCollection,
      };
    }),

  getYearComparison: financeProcedure
    .input(z.object({ sessionId: z.string(), years: z.array(z.number()).max(10) }))
    .query(async ({ ctx, input }) => {
      const assignments = await ctx.db.feeStudentClass.findMany({
        where: { year: { in: input.years }, StudentClass: { sessionId: input.sessionId } },
        include: { fees: true },
      });
      const amounts = computeFeeRows(assignments);
      return input.years.map((year) => {
        const t = sumAmounts(
          assignments.filter((f) => f.year === year).map((f) => amounts.get(f.sfcId)!),
        );
        return { year, totalExpected: t.due, totalCollected: t.paid };
      });
    }),

  getClassFees: financeProcedure
    .input(
      z.object({
        classId: z.string(),
        sessionId: z.string().optional(),
        year: z.number().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const where: Prisma.StudentClassWhereInput = { classId: input.classId };
      if (input.sessionId) where.sessionId = input.sessionId;

      const studentClasses = await ctx.db.studentClass.findMany({
        where,
        include: {
          Students: true,
          FeeStudentClass: {
            where: input.year ? { year: input.year } : undefined,
            include: { fees: true },
          },
        },
      });

      const processedClasses = studentClasses.map((sc) => {
        const amounts = computeFeeRows(sc.FeeStudentClass);
        const updatedFees = sc.FeeStudentClass.map((f) => {
          // Display only: an annual component paid on any voucher of the year shows as
          // paid on every month of that year.
          const sameYear = sc.FeeStudentClass.filter((o) => o.year === f.year);
          return {
            ...f,
            examFundPaid: sameYear.some((o) => o.examFundPaid),
            computerLabPaid: sameYear.some((o) => o.computerLabPaid),
            studentIdCardPaid: sameYear.some((o) => o.studentIdCardPaid),
            infoAndCallsPaid: sameYear.some((o) => o.infoAndCallsPaid),
            amounts: amounts.get(f.sfcId)!,
          };
        });

        return { ...sc, FeeStudentClass: updatedFees };
      });

      return { studentClasses: processedClasses };
    }),

  getStudentFees: protectedProcedure
    .input(
      z.object({
        studentId: z.string(),
        year: z.number().optional(),
        sessionId: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await assertCanReadStudent(ctx, input.studentId);
      const student = await ctx.db.students.findUnique({
        where: { studentId: input.studentId },
      });

      // A promoted student has one enrolment per session: show the requested session,
      // else the active session, else the most recent enrolment.
      const enrolments = await ctx.db.studentClass.findMany({
        where: { studentId: input.studentId },
        include: { Sessions: true },
      });
      const requested = input.sessionId
        ? enrolments.find((e) => e.sessionId === input.sessionId)
        : undefined;
      const pick =
        requested ??
        enrolments.find((e) => e.Sessions.isActive) ??
        [...enrolments].sort((a, b) =>
          (b.Sessions.sessionFrom ?? "").localeCompare(a.Sessions.sessionFrom ?? ""),
        )[0];
      if (!pick) return null;

      const studentClasses = await ctx.db.studentClass.findUnique({
        where: { scId: pick.scId },
        include: {
          Grades: true,
          Sessions: true,
          FeeStudentClass: {
            include: { fees: true },
            orderBy: [{ year: "desc" }, { month: "desc" }],
          },
        },
      });
      if (!studentClasses) return null;

      const amounts = computeFeeRows(studentClasses.FeeStudentClass);
      const ledger = studentClasses.FeeStudentClass.filter(
        (f) => !input.year || f.year === input.year,
      )
        .map((f) => ({ f, a: amounts.get(f.sfcId)! }))
        .filter(({ a }) => !a.excluded)
        .map(({ f, a }) => ({
          sfcId: f.sfcId,
          month: f.month,
          year: f.year,
          baseFee: a.base,
          discountAmount: a.discount,
          totalDue: a.due,
          paidAmount: a.paid,
          outstanding: a.outstanding,
          isPaid: a.isPaid,
          lateFee: f.lateFee,
          fees: f.fees,
          StudentClass: {
            Grades: studentClasses.Grades,
          },
        }));

      return { student, ledger };
    }),
});
