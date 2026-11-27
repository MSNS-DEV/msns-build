import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { isOffice, type AccessCtx } from "~/server/api/access";
import {
  createTRPCRouter,
  protectedProcedure,
  employeeProcedure,
  officeProcedure,
} from "../trpc";
import { type Prisma } from "@prisma/client";
import {
  AttendeeStatusSchema,
  CreateEventSchema,
  EventStatusSchema,
  UpdateEventSchema,
} from "~/lib/event-schemas";
import {
  safeTransformEventForDatabase,
  safeTransformEventForFrontend,
  safeEventUserSelect,
  type FrontendEventData,
} from "~/lib/event-helpers";

/** Only the event's creator or office staff may change an event. */
async function assertCanEditEvent(ctx: AccessCtx, eventId: string) {
  if (isOffice(ctx)) return;
  const event = await ctx.db.event.findUnique({
    where: { id: eventId },
    select: { User: { select: { id: true } } },
  });
  if (!event)
    throw new TRPCError({ code: "NOT_FOUND", message: "Event not found" });
  if (!event.User.some((u) => u.id === ctx.session?.user.id)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only the organiser can change this event",
    });
  }
}

export const EventRouter = createTRPCRouter({
  create: employeeProcedure
    .input(CreateEventSchema)
    .mutation(async ({ ctx, input }): Promise<FrontendEventData> => {
      const eventData = safeTransformEventForDatabase(input);
      const event = await ctx.db.event.create({
        data: {
          ...eventData,
          User: { connect: { id: ctx.session.user.id } },
          tags: input.tagIds
            ? {
                create: input.tagIds.map((tagId: string) => ({
                  tag: { connect: { id: tagId } },
                })),
              }
            : undefined,
          reminders: input.reminders
            ? {
                create: input.reminders.map((reminder) => ({
                  type: reminder.type,
                  minutesBefore: reminder.value,
                })),
              }
            : undefined,
          attendees: input.attendees
            ? {
                create: input.attendees.map((attendee) => ({
                  user: { connect: { id: attendee.userId } },
                  status: attendee.status,
                })),
              }
            : undefined,
        },
        include: {
          User: { select: safeEventUserSelect },
          tags: { include: { tag: true } },
          attendees: { include: { user: { select: { id: true } } } },
          reminders: true,
        },
      });
      return safeTransformEventForFrontend(event);
    }),

  update: employeeProcedure
    .input(UpdateEventSchema)
    .mutation(async ({ ctx, input }): Promise<FrontendEventData> => {
      await assertCanEditEvent(ctx, input.id);
      const eventData = safeTransformEventForDatabase(input);
      const event = await ctx.db.event.update({
        where: { id: input.id },
        data: {
          ...eventData,
          tags: input.tagIds
            ? {
                deleteMany: {},
                create: input.tagIds.map((tagId: string) => ({
                  tag: { connect: { id: tagId } },
                })),
              }
            : undefined,
          reminders: input.reminders
            ? {
                deleteMany: {},
                create: input.reminders.map((reminder) => ({
                  type: reminder.type,
                  minutesBefore: reminder.value,
                })),
              }
            : undefined,
          attendees: input.attendees
            ? {
                deleteMany: {},
                create: input.attendees.map((attendee) => ({
                  user: { connect: { id: attendee.userId } },
                  status: attendee.status,
                })),
              }
            : undefined,
        },
        include: {
          User: { select: safeEventUserSelect },
          tags: { include: { tag: true } },
          attendees: { include: { user: { select: { id: true } } } },
          reminders: true,
        },
      });
      return safeTransformEventForFrontend(event);
    }),

  getById: protectedProcedure
    .input(z.object({ id: z.string().min(1, "Event ID is required") }))
    .query(async ({ ctx, input }): Promise<FrontendEventData> => {
      const event = await ctx.db.event.findUnique({
        where: { id: input.id },
        include: {
          User: { select: safeEventUserSelect },
          tags: { include: { tag: true } },
          attendees: { include: { user: { select: { id: true } } } },
          reminders: true,
        },
      });
      if (!event) {
        throw new Error("Event not found");
      }
      return safeTransformEventForFrontend(event);
    }),

  getAll: protectedProcedure
    .input(
      z.object({
        search: z.string().optional(),
        status: EventStatusSchema.optional(),
        offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().positive().default(10),
      }),
    )
    .query(
      async ({
        ctx,
        input,
      }): Promise<{ events: FrontendEventData[]; total: number }> => {
        const where: Prisma.EventWhereInput = {
          AND: [
            input.search
              ? {
                  OR: [
                    { title: { contains: input.search, mode: "insensitive" } },
                    {
                      description: {
                        contains: input.search,
                        mode: "insensitive",
                      },
                    },
                    {
                      location: { contains: input.search, mode: "insensitive" },
                    },
                  ],
                }
              : {},
            input.status ? { status: input.status } : {},
          ],
        };

        const [events, total] = await Promise.all([
          ctx.db.event.findMany({
            where,
            include: {
              User: { select: safeEventUserSelect },
              tags: { include: { tag: true } },
              attendees: { include: { user: { select: { id: true } } } },
              reminders: true,
            },
            skip: input.offset,
            take: input.limit,
          }),
          ctx.db.event.count({ where }),
        ]);

        return {
          events: events.map(safeTransformEventForFrontend),
          total,
        };
      },
    ),

  delete: employeeProcedure
    .input(z.object({ id: z.string().min(1, "Event ID is required") }))
    .mutation(async ({ ctx, input }): Promise<{ success: boolean }> => {
      await assertCanEditEvent(ctx, input.id);
      await ctx.db.event.delete({
        where: { id: input.id },
      });
      return { success: true };
    }),

  updateAttendeeStatus: protectedProcedure
    .input(
      z.object({
        eventId: z.string().min(1, "Event ID is required"),
        userId: z.string().min(1, "User ID is required"),
        status: AttendeeStatusSchema,
      }),
    )
    .mutation(
      async ({ ctx, input }): Promise<{ userId: string; status: string }> => {
        if (input.userId !== ctx.session.user.id) {
          await assertCanEditEvent(ctx, input.eventId);
        }
        const attendee = await ctx.db.attendee.upsert({
          where: {
            eventId_userId: { eventId: input.eventId, userId: input.userId },
          },
          update: { status: input.status },
          create: {
            eventId: input.eventId,
            userId: input.userId,
            status: input.status,
          },
          include: { user: { select: { id: true } } },
        });
        return { userId: attendee.userId, status: attendee.status };
      },
    ),

  createTag: employeeProcedure
    .input(
      z.object({
        name: z.string().min(1, "Tag name is required"),
        color: z.string().min(1, "Tag color is required"),
      }),
    )
    .mutation(
      async ({
        ctx,
        input,
      }): Promise<{ id: string; name: string; color: string }> => {
        const tag = await ctx.db.tag.create({
          data: { name: input.name, color: input.color },
        });
        return { id: tag.id, name: tag.name, color: tag.color };
      },
    ),

  getTags: protectedProcedure.query(
    async ({ ctx }): Promise<{ id: string; name: string; color: string }[]> => {
      return ctx.db.tag.findMany();
    },
  ),

  getRecentActivity: officeProcedure
    .input(z.object({ limit: z.number().int().positive().default(8) }))
    .query(async ({ ctx, input }) => {
      const perSource = Math.max(3, Math.ceil(input.limit / 2));

      const [recentStudents, recentFees, recentDiaries] = await Promise.all([
        ctx.db.students.findMany({
          orderBy: { createdAt: "desc" },
          take: perSource,
          include: {
            StudentClass: {
              take: 1,
              include: { Grades: { select: { grade: true, section: true } } },
            },
          },
        }),
        ctx.db.feeStudentClass.findMany({
          where: { tuitionPaid: true, paidAt: { not: null } },
          orderBy: { paidAt: "desc" },
          take: perSource,
          include: {
            StudentClass: {
              include: {
                Students: { select: { studentName: true } },
                Grades: { select: { grade: true, section: true } },
              },
            },
          },
        }),
        ctx.db.subjectDiary.findMany({
          orderBy: { createdAt: "desc" },
          take: perSource,
          include: {
            Teacher: { select: { employeeName: true } },
            ClassSubject: {
              include: { Subject: { select: { subjectName: true } } },
            },
          },
        }),
      ]);

      type ActivityItem = {
        type: "student" | "fee" | "diary";
        text: string;
        time: Date;
      };

      const activities: ActivityItem[] = [
        ...recentStudents.map((s) => ({
          type: "student" as const,
          text: `${s.studentName} was registered${
            s.StudentClass[0]?.Grades
              ? ` in Grade ${s.StudentClass[0].Grades.grade} (${s.StudentClass[0].Grades.section})`
              : ""
          }.`,
          time: s.createdAt,
        })),
        ...recentFees
          .filter((f) => f.paidAt !== null)
          .map((f) => ({
            type: "fee" as const,
            text: `Fee collected for ${f.StudentClass.Students.studentName} \u2014 Grade ${f.StudentClass.Grades.grade}.`,
            time: f.paidAt!,
          })),
        ...recentDiaries.map((d) => ({
          type: "diary" as const,
          text: `${d.Teacher.employeeName} added a ${d.ClassSubject.Subject.subjectName} diary entry.`,
          time: d.createdAt,
        })),
      ];

      return activities
        .sort((a, b) => b.time.getTime() - a.time.getTime())
        .slice(0, input.limit);
    }),
});
