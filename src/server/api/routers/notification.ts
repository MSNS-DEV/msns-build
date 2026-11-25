import { z } from "zod";
import {
  createTRPCRouter,
  protectedProcedure,
  leadershipProcedure,
} from "../trpc";
import { Designation, NotificationCategory, type Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";

type NotifCtx = {
  session: { user: { id: string; accountType: string } };
};

/** Shared rows visible to the caller: their role's broadcasts and global broadcasts. */
function sharedVisibilityFilter(
  ctx: NotifCtx,
): Prisma.NotificationWhereInput[] {
  const role = ctx.session.user.accountType;
  const filters: Prisma.NotificationWhereInput[] = [
    { AND: [{ userId: null }, { targetRole: null }] },
  ];
  // PARENT is not a Designation value; only filter by role when it is one.
  if ((Object.values(Designation) as string[]).includes(role)) {
    filters.push({ userId: null, targetRole: role as Designation });
  }
  return filters;
}

/** Everything visible to the caller that they haven't dismissed. */
function visibleFilter(ctx: NotifCtx): Prisma.NotificationWhereInput {
  const userId = ctx.session.user.id;
  return {
    OR: [
      { userId },
      {
        AND: [
          { OR: sharedVisibilityFilter(ctx) },
          { Receipts: { none: { userId, dismissedAt: { not: null } } } },
        ],
      },
    ],
  };
}

export const notificationRouter = createTRPCRouter({
  /**
   * Fetch recent notifications for the authenticated user: personal
   * notifications plus role-specific and global broadcasts. Read/dismissed
   * state for broadcasts is tracked per user in NotificationReceipt.
   */
  getAll: protectedProcedure
    .input(
      z
        .object({
          category: z.nativeEnum(NotificationCategory).optional(),
          limit: z.number().min(1).max(100).default(50),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const rows = await ctx.db.notification.findMany({
        where: {
          ...visibleFilter(ctx),
          ...(input?.category && { category: input.category }),
        },
        orderBy: { createdAt: "desc" },
        take: input?.limit ?? 50,
        select: {
          id: true,
          userId: true,
          targetRole: true,
          title: true,
          body: true,
          category: true,
          actionUrl: true,
          read: true,
          data: true,
          createdAt: true,
          Receipts: { where: { userId }, select: { readAt: true } },
        },
      });
      return rows.map(({ Receipts, ...n }) => ({
        ...n,
        read: n.userId === userId ? n.read : Boolean(Receipts[0]?.readAt),
      }));
    }),

  /**
   * Fast unread notification counter for the navbar/bell badge.
   */
  getUnreadCount: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.session.user.id;
    const [own, shared] = await Promise.all([
      ctx.db.notification.count({ where: { userId, read: false } }),
      ctx.db.notification.count({
        where: {
          OR: sharedVisibilityFilter(ctx),
          Receipts: {
            none: {
              userId,
              OR: [{ readAt: { not: null } }, { dismissedAt: { not: null } }],
            },
          },
        },
      }),
    ]);
    return own + shared;
  }),

  /**
   * Mark an individual notification as read (for the caller only).
   */
  markAsRead: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const n = await ctx.db.notification.findFirst({
        where: { id: input.id, ...visibleFilter(ctx) },
        select: { id: true, userId: true },
      });
      if (!n)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Notification not found",
        });
      if (n.userId === userId) {
        return ctx.db.notification.update({
          where: { id: n.id },
          data: { read: true },
          select: { id: true, read: true },
        });
      }
      await ctx.db.notificationReceipt.upsert({
        where: { notificationId_userId: { notificationId: n.id, userId } },
        create: { notificationId: n.id, userId, readAt: new Date() },
        update: { readAt: new Date() },
      });
      return { id: n.id, read: true };
    }),

  /**
   * Mark all notifications visible to the caller as read (for the caller only).
   */
  markAllAsRead: protectedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.session.user.id;
    const own = await ctx.db.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    });
    const shared = await ctx.db.notification.findMany({
      where: {
        OR: sharedVisibilityFilter(ctx),
        Receipts: { none: { userId, readAt: { not: null } } },
      },
      select: { id: true },
    });
    const now = new Date();
    await ctx.db.$transaction(
      shared.map((n) =>
        ctx.db.notificationReceipt.upsert({
          where: { notificationId_userId: { notificationId: n.id, userId } },
          create: { notificationId: n.id, userId, readAt: now },
          update: { readAt: now },
        }),
      ),
    );
    return { count: own.count + shared.length };
  }),

  /**
   * Delete a personal notification, or hide a broadcast for the caller only.
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const n = await ctx.db.notification.findFirst({
        where: { id: input.id, ...visibleFilter(ctx) },
        select: { id: true, userId: true },
      });
      if (!n)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Notification not found",
        });
      if (n.userId === userId) {
        return ctx.db.notification.delete({
          where: { id: n.id },
          select: { id: true },
        });
      }
      await ctx.db.notificationReceipt.upsert({
        where: { notificationId_userId: { notificationId: n.id, userId } },
        create: { notificationId: n.id, userId, dismissedAt: new Date() },
        update: { dismissedAt: new Date() },
      });
      return { id: n.id };
    }),

  /**
   * Clear the caller's notifications. Personal rows are deleted; broadcasts
   * are only hidden for the caller and stay visible to everyone else.
   */
  clearAll: protectedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.session.user.id;
    const own = await ctx.db.notification.deleteMany({ where: { userId } });
    const shared = await ctx.db.notification.findMany({
      where: {
        OR: sharedVisibilityFilter(ctx),
        Receipts: { none: { userId, dismissedAt: { not: null } } },
      },
      select: { id: true },
    });
    const now = new Date();
    await ctx.db.$transaction(
      shared.map((n) =>
        ctx.db.notificationReceipt.upsert({
          where: { notificationId_userId: { notificationId: n.id, userId } },
          create: { notificationId: n.id, userId, dismissedAt: now },
          update: { dismissedAt: now },
        }),
      ),
    );
    return { count: own.count + shared.length };
  }),

  /**
   * Dispatch a notification (restricted to ADMIN, HEAD, PRINCIPAL).
   */
  send: leadershipProcedure
    .input(
      z.object({
        title: z.string().min(1),
        body: z.string().min(1),
        category: z
          .nativeEnum(NotificationCategory)
          .default(NotificationCategory.SYSTEM),
        actionUrl: z.string().optional(),
        userId: z.string().optional(),
        targetRole: z.nativeEnum(Designation).optional(),
        data: z.record(z.unknown()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return await ctx.db.notification.create({
        data: {
          title: input.title,
          body: input.body,
          category: input.category,
          actionUrl: input.actionUrl,
          userId: input.userId,
          targetRole: input.targetRole,
          data: input.data as Prisma.InputJsonValue | undefined,
        },
        select: {
          id: true,
          title: true,
          category: true,
          createdAt: true,
        },
      });
    }),
});
