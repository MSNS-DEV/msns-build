import { z } from "zod";
import { assertNoPaidVouchers } from "~/server/utils/financial-guards";
import { getOwnStudentIds } from "~/server/api/access";
import { createTRPCRouter, protectedProcedure, officeProcedure, teacherProcedure } from "../trpc";
import { TRPCError } from "@trpc/server";
import { Prisma, type StudentClass, type Grades, type Sessions, type Students } from "@prisma/client";

// Define a relation type based on your Prisma schema. Adjust field names as needed.
type StudentClassWithRelations = StudentClass & {
  Grades: Grades;
  Sessions: Sessions;
  Students: Students;
};

export const AllotmentRouter = createTRPCRouter({
  addToClass: officeProcedure
    .input(
      z.object({
        classId: z.string().cuid(),
        studentId: z.string().cuid(),
        sessionId: z.string().cuid(),
      }),
    )
    .mutation<StudentClassWithRelations>(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction(async (tx) => {
          // Check existing assignment
          const existingAssignment = await tx.studentClass.findFirst({
            where: {
              studentId: input.studentId,
              sessionId: input.sessionId,
            },
          });

          if (existingAssignment) {
            throw new TRPCError({
              code: "CONFLICT",
              message:
                existingAssignment.classId === input.classId
                  ? "Student is already in this class for this session"
                  : "Student is already in another class this session. Use Move to change class so fee history is kept.",
            });
          }

          // Update student assignment status
          await tx.students.update({
            where: { studentId: input.studentId },
            data: { isAssign: true },
          });

          // Create new student-class association
          const newAssignment = await tx.studentClass.create({
            data: {
              classId: input.classId,
              studentId: input.studentId,
              sessionId: input.sessionId,
            },
            include: {
              Grades: true,
              Students: true, // Use the correct relation name
              Sessions: true,
            },
          });

          return newAssignment;
        });
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        // Concurrent "add to class" for the same student: the unique (student, session) key wins.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Student already assigned to a class in this session",
          });
        }
        console.error("Error adding to class:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to add student to class",
        });
      }
    }),

  /**
   * Moves a student to another class within the same session. The enrolment (and its fee
   * vouchers, attendance links and payments) is kept; only the class changes.
   */
  moveStudentToClass: officeProcedure
    .input(
      z.object({
        studentId: z.string().cuid(),
        sessionId: z.string().cuid(),
        toClassId: z.string().cuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const enrolment = await ctx.db.studentClass.findFirst({
        where: { studentId: input.studentId, sessionId: input.sessionId },
      });
      if (!enrolment) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Student is not enrolled in a class this session",
        });
      }
      if (enrolment.classId === input.toClassId) return enrolment;
      return ctx.db.studentClass.update({
        where: { scId: enrolment.scId },
        data: { classId: input.toClassId },
        include: { Grades: true, Students: true, Sessions: true },
      });
    }),

  getStudentsInClass: teacherProcedure
    .input(z.object({ classId: z.string().cuid() }))
    .query<StudentClassWithRelations[]>(async ({ ctx, input }) => {
      try {
        return await ctx.db.studentClass.findMany({
          where: { classId: input.classId },
          include: {
            Grades: true,
            Students: true, // Corrected relation name
            Sessions: true,
          },
          // Ensure a comma follows the include block
          orderBy: { Students: { studentName: "asc" } },
        });
      } catch (error) {
        console.error("Error fetching students in class:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to retrieve class students",
        });
      }
    }),

  getStudentsByClassAndSession: protectedProcedure
    .input(
      z.object({
        classId: z.string().cuid().optional(), // Made optional to handle undefined/null from client
        sessionId: z.string().cuid().optional(), // Made optional to handle undefined/null from client
        page: z.number().min(1).default(1),
        pageSize: z.number().min(1).max(100).default(20),
      }),
    )
    .query<{
      [x: string]: unknown;
      data: StudentClassWithRelations[];
      meta: PaginationMeta;
    }>(async ({ ctx, input }) => {
      try {
        // Explicitly check if classId and sessionId are provided, as they are required for the query
        if (!input.classId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "classId is required to fetch students by class and session.",
          });
        }
        if (!input.sessionId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "sessionId is required to fetch students by class and session.",
          });
        }

        // Students/parents only see their own enrolment row (no classmates' PII).
        const ownIds = await getOwnStudentIds(ctx);
        const rosterWhere = {
          classId: input.classId,
          sessionId: input.sessionId,
          ...(ownIds !== null && { studentId: { in: ownIds } }),
        };

        const [data, total] = await Promise.all([
          ctx.db.studentClass.findMany({
            where: rosterWhere,
            include: {
              Grades: true,
              Students: true, // Corrected relation name
              Sessions: true,
            },
            orderBy: { Students: { studentName: "asc" } },
            skip: (input.page - 1) * input.pageSize,
            take: input.pageSize,
          }),
          ctx.db.studentClass.count({ where: rosterWhere }),
        ]);

        return {
          data,
          meta: {
            total,
            page: input.page,
            pageSize: input.pageSize,
            totalPages: Math.ceil(total / input.pageSize),
          },
        };
      } catch (error) {
        console.error("Error fetching students:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to retrieve students",
        });
      }
    }),

  deleteStudentsFromClass: officeProcedure
    .input(
      z.object({
        studentIds: z.array(z.string().cuid()),
        classId: z.string().cuid(),
        sessionId: z.string().cuid(),
      }),
    )
    .mutation<{ success: boolean; message: string }>(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction(async (tx) => {
          // Find student-class associations
          const studentClasses = await tx.studentClass.findMany({
            where: {
              studentId: { in: input.studentIds },
              classId: input.classId,
              sessionId: input.sessionId,
            },
            select: { scId: true, studentId: true },
          });

          if (studentClasses.length === 0) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "No matching student-class associations found",
            });
          }

          const studentClassIds = studentClasses.map((sc) => sc.scId);
          await assertNoPaidVouchers(
            tx,
            { studentClassId: { in: studentClassIds } },
            "remove these students from the class",
          );
          const uniqueStudentIds = [
            ...new Set(studentClasses.map((sc) => sc.studentId)),
          ];

          // Delete dependent fee records
          await tx.feeStudentClass.deleteMany({
            where: { studentClassId: { in: studentClassIds } },
          });

          // Delete student-class associations
          await tx.studentClass.deleteMany({
            where: { scId: { in: studentClassIds } },
          });

          // Update student assignment status if no other classes
          await tx.students.updateMany({
            where: {
              studentId: { in: uniqueStudentIds },
              NOT: { StudentClass: { some: {} } },
            },
            data: { isAssign: false },
          });

          return {
            success: true,
            message: `Removed ${studentClasses.length} student(s) from class`,
          };
        });
      } catch (error) {
        console.error("Error removing students:", error);
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to remove students from class",
        });
      }
    }),
});

// Type definitions
type PaginationMeta = {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};
