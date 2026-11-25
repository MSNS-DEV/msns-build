import { z } from "zod";
import {
  createTRPCRouter,
  officeProcedure,
  teacherProcedure,
  protectedProcedure,
} from "../trpc";
import { after } from "next/server";
import { pkYmd } from "~/server/utils/pk-time";
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
              // School-time date: the server clock is UTC, so before 05:00 PKT dayjs()
              // gave yesterday's date.
              date: pkYmd(),
              employeeId: input.employeeId,
            },
          },
          create: {
            employeeId: input.employeeId,
            date: pkYmd(),
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
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
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
      await assertCanTeachClass(ctx, {
        classId: input.classId,
        sessionId: input.sessionId,
      });
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
          message:
            "Some students are not enrolled in this class for this session",
        });
      }
      try {
        // One transaction: a pool timeout part-way no longer leaves half the class marked.
        await ctx.db.$transaction(
          input.records.map((record) =>
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
          ),
        );

        // Absence alerts after the response, so they are not dropped when the function freezes.
        const absentIds = input.records
          .filter((r) => r.status === "A")
          .map((r) => r.studentId);
        if (absentIds.length > 0) {
          const db = ctx.db;
          after(async () => {
            try {
              const [students, parents] = await Promise.all([
                db.students.findMany({
                  where: { studentId: { in: absentIds } },
                  select: { studentId: true, studentName: true },
                }),
                db.parentGuardian.findMany({
                  where: { linkedStudentIds: { hasSome: absentIds } },
                  select: { guardentId: true, linkedStudentIds: true },
                }),
              ]);
              const { sendPushNotification } =
                await import("~/server/mobile/fcm");
              for (const st of students) {
                const parentIds = parents
                  .filter((p) => p.linkedStudentIds.includes(st.studentId))
                  .map((p) => p.guardentId);
                if (parentIds.length > 0) {
                  await sendPushNotification(
                    [],
                    parentIds,
                    "Attendance Alert",
                    `${st.studentName ?? "Student"} was marked ABSENT on ${input.date}.`,
                  );
                }
              }
            } catch (err) {
              console.error(
                "Failed to send student attendance push notification:",
                err,
              );
            }
          });
        }

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
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
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
