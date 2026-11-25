import { z } from "zod";
import { pkDayEnd, pkDayStart } from "~/server/utils/pk-time";
import { TRPCError } from "@trpc/server";
import {
  createTRPCRouter,
  protectedProcedure,
  teacherProcedure,
} from "../trpc";
import {
  assertCanTeachClassSubject,
  requireSessionEmployee,
  roleOf,
} from "~/server/api/access";
import type { Prisma } from "@prisma/client";

export const subjectDiaryRouter = createTRPCRouter({
  createDiary: teacherProcedure
    .input(
      z.object({
        classSubjectId: z.string(),
        // Ignored for teachers (taken from the session); office staff may set it.
        teacherId: z.string().optional(),
        date: z.date(),
        content: z.string(),
        attachments: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertCanTeachClassSubject(ctx, input.classSubjectId);
      let teacherId: string;
      if (roleOf(ctx) === "TEACHER") {
        teacherId = (await requireSessionEmployee(ctx)).employeeId;
      } else {
        const cs = await ctx.db.classSubject.findUnique({
          where: { csId: input.classSubjectId },
          select: { employeeId: true },
        });
        if (!cs)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Class subject not found",
          });
        teacherId = input.teacherId ?? cs.employeeId;
      }
      try {
        const diary = await ctx.db.subjectDiary.create({
          data: {
            classSubjectId: input.classSubjectId,
            teacherId,
            date: input.date,
            content: input.content,
            attachments: input.attachments ?? [],
          },
        });

        // Run FCM alerts asynchronously
        void (async () => {
          try {
            const classSub = await ctx.db.classSubject.findUnique({
              where: { csId: input.classSubjectId },
              select: {
                classId: true,
                sessionId: true,
                Subject: { select: { subjectName: true } },
              },
            });
            if (classSub) {
              const students = await ctx.db.studentClass.findMany({
                where: {
                  classId: classSub.classId,
                  sessionId: classSub.sessionId,
                },
                select: { studentId: true },
              });
              const studentIds = students.map((s) => s.studentId);
              const parents = await ctx.db.parentGuardian.findMany({
                where: { linkedStudentIds: { hasSome: studentIds } },
                select: { guardentId: true },
              });
              const parentIds = parents.map((p) => p.guardentId);
              if (parentIds.length > 0) {
                const { sendPushNotification } =
                  await import("~/server/mobile/fcm");
                await sendPushNotification(
                  [],
                  parentIds,
                  "New Diary Published",
                  `A new diary entry has been published for ${classSub.Subject.subjectName}.`,
                );
              }
            }
          } catch (err) {
            console.error("Failed to send diary push notification:", err);
          }
        })();

        return diary;
      } catch (error) {
        console.error("Error creating subject diary:", error);
        throw new Error("Failed to create subject diary");
      }
    }),

  updateDiary: teacherProcedure
    .input(
      z.object({
        subjectDiaryId: z.string(),
        content: z.string(),
        attachments: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.subjectDiary.findUnique({
        where: { subjectDiaryId: input.subjectDiaryId },
        select: { classSubjectId: true },
      });
      if (!existing)
        throw new TRPCError({ code: "NOT_FOUND", message: "Diary not found" });
      await assertCanTeachClassSubject(ctx, existing.classSubjectId);
      try {
        return await ctx.db.subjectDiary.update({
          where: { subjectDiaryId: input.subjectDiaryId },
          data: {
            content: input.content,
            attachments: input.attachments,
          },
        });
      } catch (error) {
        console.error("Error updating subject diary:", error);
        throw new Error("Failed to update subject diary");
      }
    }),

  deleteDiary: teacherProcedure
    .input(z.object({ subjectDiaryId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.subjectDiary.findUnique({
        where: { subjectDiaryId: input.subjectDiaryId },
        select: { classSubjectId: true },
      });
      if (!existing)
        throw new TRPCError({ code: "NOT_FOUND", message: "Diary not found" });
      await assertCanTeachClassSubject(ctx, existing.classSubjectId);
      try {
        await ctx.db.subjectDiary.delete({
          where: { subjectDiaryId: input.subjectDiaryId },
        });
        return { success: true };
      } catch (error) {
        console.error("Error deleting subject diary:", error);
        throw new Error("Failed to delete subject diary");
      }
    }),

  getTeacherDiaries: teacherProcedure
    .input(
      z.object({
        teacherId: z.string(),
        date: z.date().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        const whereClause: Prisma.SubjectDiaryWhereInput = {
          teacherId: input.teacherId,
        };

        // If date is provided, match exactly by day
        if (input.date) {
          // School-time day (the server runs in UTC).
          const startDate = pkDayStart(input.date);
          const endDate = pkDayEnd(input.date);

          whereClause.date = {
            gte: startDate,
            lte: endDate,
          };
        }

        return await ctx.db.subjectDiary.findMany({
          where: whereClause,
          include: {
            ClassSubject: {
              include: {
                Subject: { select: { subjectName: true } },
                Grades: { select: { grade: true, section: true } },
              },
            },
          },
          orderBy: { date: "desc" },
        });
      } catch (error) {
        console.error("Error fetching teacher diaries:", error);
        throw new Error("Failed to fetch teacher diaries");
      }
    }),

  getClassDiaries: protectedProcedure
    .input(
      z.object({
        classId: z.string(),
        sessionId: z.string(),
        date: z.date().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        const whereClause: Prisma.SubjectDiaryWhereInput = {
          ClassSubject: {
            classId: input.classId,
            sessionId: input.sessionId,
          },
        };

        if (input.date) {
          // School-time day (the server runs in UTC).
          const startDate = pkDayStart(input.date);
          const endDate = pkDayEnd(input.date);

          whereClause.date = {
            gte: startDate,
            lte: endDate,
          };
        }

        return await ctx.db.subjectDiary.findMany({
          where: whereClause,
          include: {
            Teacher: { select: { employeeName: true } },
            ClassSubject: {
              include: {
                Subject: { select: { subjectName: true } },
              },
            },
          },
          orderBy: { date: "desc" },
        });
      } catch (error) {
        console.error("Error fetching class diaries:", error);
        throw new Error("Failed to fetch class diaries");
      }
    }),
});
