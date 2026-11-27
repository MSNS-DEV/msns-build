import { db } from "~/server/db";

export const sendPushNotification = async (
  userIds: string[],
  parentGuardianIds: string[],
  title: string,
  _body: string,
  _data?: Record<string, string>,
) => {
  // Do not log recipient ids, message bodies or device tokens (personal data / credentials).

  try {
    const prismaDb = db as unknown as {
      deviceRegistration: {
        findMany: (args: {
          where: {
            OR: (
              | { userId: { in: string[] } }
              | { parentGuardianId: { in: string[] } }
            )[];
          };
          select: { token: boolean };
        }) => Promise<{ token: string }[]>;
      };
    };
    const registrations = await prismaDb.deviceRegistration.findMany({
      where: {
        OR: [
          { userId: { in: userIds.filter(Boolean) } },
          { parentGuardianId: { in: parentGuardianIds.filter(Boolean) } },
        ],
      },
      select: { token: true },
    });

    const tokens = registrations.map((r: { token: string }) => r.token);
    if (tokens.length === 0) {
      console.log(
        "[FCM Push] No registered device tokens for this notification.",
      );
      return;
    }

    console.log(
      `[FCM Push] Mock send "${title}" to ${tokens.length} device(s).`,
    );
  } catch (error) {
    console.error(
      "[FCM Push] Error fetching tokens / sending notification:",
      error,
    );
  }
};
