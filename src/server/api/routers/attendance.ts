import { z } from "zod";
import { createTRPCRouter, officeProcedure, teacherProcedure, protectedProcedure } from "../trpc";
import dayjs from "dayjs";
import { TRPCError } from "@trpc/server";
import { assertCanTeachClass, getOwnStudentIds } from "~/server/api/access";

export const attendanceRouter = createTRPCRouter({
  addEmployeeAttendance: officeProcedure
    .input(
      z.object({
        employeeId: z.string(),
        timeSlot: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await ctx.db.employeeAttendance.upsert({
          where: {
            employeeId_date: {
              date: dayjs().format("YYYY-MM-DD"),
              employeeId: input.employeeId,
            },
          },
          create: {
            employeeId: input.employeeId,
            date: dayjs().format("YYYY-MM-DD"),
            morning: input.timeSlot === "first" ? "P" : "A",
            afternoon: input.timeSlot === "second" ? "P" : "A",
          },
          update: {
            ...(input.timeSlot === "first" && { morning: "P" }),
            ...(input.timeSlot === "second" && { afternoon: "P" }),
          },
        });
      } catch (error) {
        console.error(error);
        throw new Error("Something went wrong");
      }
    }),
  getAllEmployeeAttendance: officeProcedure.query(async ({ ctx }) => {
    try {
      return await ctx.db.employeeAttendance.findMany();
    } catch (error) {
      console.error(error);
      throw new Error("Something went wrong");
    }
  }),

  // --- Student Attendance ---
  markStudentAttendance: teacherProcedure
    .input(
      z.object({
        classId: z.string(),
        sessionId: z.string(),
        date: z.string(), // YYYY-MM-DD
        records: z.array(
          z.object({
            studentId: z.string(),
            status: z.enum(["P", "A", "L"]),
            remarks: z.string().optional(),
          }),
        ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertCanTeachClass(ctx, { classId: input.classId, sessionId: input.sessionId });
      const enrolled = await ctx.db.studentClass.count({
        where: {
          classId: input.classId,
          sessionId: input.sessionId,
          studentId: { in: input.records.map((r) => r.studentId) },
        },
      });
      if (enrolled !== new Set(input.records.map((r) => r.studentId)).size) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Some students are not enrolled in this class for this session",
        });
      }
      try {
        const upsertPromises = input.records.map((record) =>
          ctx.db.studentAttendance.upsert({
            where: {
              studentId_classId_sessionId_date: {
                studentId: record.studentId,
                classId: input.classId,
                sessionId: input.sessionId,
                date: input.date,
              },
            },
            update: {
              status: record.status,
              remarks: record.remarks,
            },
            create: {
              studentId: record.studentId,
              classId: input.classId,
              sessionId: input.sessionId,
              date: input.date,
              status: record.status,
              remarks: record.remarks,
            },
          }),
        );
        await Promise.all(upsertPromises);

        // Run FCM alerts asynchronously
        void (async () => {
          try {
            const absentRecords = input.records.filter((r) => r.status === "A");
            for (const record of absentRecords) {
              const student = await ctx.db.students.findUnique({
                where: { studentId: record.studentId },
                select: { studentName: true },
              });
              const name = student?.studentName ?? "Student";
              const parents = await ctx.db.parentGuardian.findMany({
                where: { linkedStudentIds: { has: record.studentId } },
                select: { guardentId: true },
              });
              const parentIds = parents.map((p) => p.guardentId);
              if (parentIds.length > 0) {
                const { sendPushNotification } = await import("~/server/mobile/fcm");
                await sendPushNotification([], parentIds, "Attendance Alert", `${name} was marked ABSENT today (${input.date}).`);
              }
            }
          } catch (err) {
            console.error("Failed to send student attendance push notification:", err);
          }
        })();

        return { success: true };
      } catch (error) {
        console.error("Error marking student attendance:", error);
        throw new Error("Failed to mark student attendance");
      }
    }),

  getStudentAttendanceByClass: protectedProcedure
    .input(
      z.object({
        classId: z.string(),
        sessionId: z.string(),
        date: z.string(), // YYYY-MM-DD
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        // Students/parents only see their own rows; staff see the whole class.
        const ownIds = await getOwnStudentIds(ctx);
        return await ctx.db.studentAttendance.findMany({
          where: {
            classId: input.classId,
            sessionId: input.sessionId,
            date: input.date,
            ...(ownIds !== null && { studentId: { in: ownIds } }),
          },
        });
      } catch (error) {
        console.error("Error fetching class attendance:", error);
        throw new Error("Failed to fetch class attendance");
      }
    }),
});
