import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";

// FCM registration tokens are ~150-180 chars of [A-Za-z0-9_:-].
const fcmToken = z
  .string()
  .min(20)
  .max(4096)
  .regex(/^[A-Za-z0-9_:\-.]+$/, "Invalid device token");

type DeviceRegistrationDb = {
  deviceRegistration: {
    upsert: (args: {
      where: { token: string };
      update: {
        platform: string;
        userId: string | null;
        parentGuardianId: string | null;
      };
      create: {
        token: string;
        platform: string;
        userId: string | null;
        parentGuardianId: string | null;
      };
    }) => Promise<{ id: string; token: string; platform: string }>;
    deleteMany: (args: {
      where: {
        token: string;
        OR: ({ userId: string } | { parentGuardianId: string })[];
      };
    }) => Promise<{ count: number }>;
  };
};

/*
 * Ownership model: an FCM token identifies one app install and is only handed to
 * that install by Firebase. Whoever is signed in on the device owns its token, so
 * registerDevice re-binds an existing token to the caller (this is what makes a
 * shared/handed-down phone stop receiving the previous user's alerts). The token
 * is treated as a secret: it is never returned by any API or written to logs, and
 * the device unregisters on logout.
 */
export const mobileRouter = createTRPCRouter({
  registerDevice: protectedProcedure
    .input(
      z.object({
        token: fcmToken,
        platform: z.enum(["android", "ios"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const isParent = ctx.session.user.accountType === "PARENT";
      const owner = {
        userId: isParent ? null : userId,
        parentGuardianId: isParent ? userId : null,
      };

      try {
        const db = ctx.db as unknown as DeviceRegistrationDb;
        await db.deviceRegistration.upsert({
          where: { token: input.token },
          update: { platform: input.platform, ...owner },
          create: { token: input.token, platform: input.platform, ...owner },
        });
        return { success: true };
      } catch (error) {
        console.error(
          "Device registration error:",
          error instanceof Error ? error.message : error,
        );
        throw new Error("Failed to register device");
      }
    }),

  unregisterDevice: protectedProcedure
    .input(z.object({ token: fcmToken }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const db = ctx.db as unknown as DeviceRegistrationDb;
      // Only remove the caller's own binding for this token.
      const { count } = await db.deviceRegistration.deleteMany({
        where: {
          token: input.token,
          OR: [{ userId }, { parentGuardianId: userId }],
        },
      });
      return { success: true, removed: count };
    }),
});
