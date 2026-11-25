import { useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import {
  registerPushNotifications,
  isNative,
  type PushRegistrationHandle,
} from "~/lib/mobile/native-service";
import { api } from "~/trpc/react";

// One push registration per app process, even if several components mount the hook
// or React re-runs effects (Strict Mode, fast refresh).
let pushRegistration: Promise<PushRegistrationHandle | null> | null = null;
// Kept in memory only (never persisted or logged) so logout can unregister it.
let currentPushToken: string | null = null;

export const getCurrentPushToken = () => currentPushToken;

export const resetDeviceRegistration = async () => {
  const pending = pushRegistration;
  pushRegistration = null;
  currentPushToken = null;
  const handle = await pending;
  await handle?.remove();
};

export const useDeviceRegistration = () => {
  const { status } = useSession();
  const { mutate } = api.mobile.registerDevice.useMutation();

  // Keep the latest mutate in a ref so the effect does not re-run when the
  // mutation object changes identity on every render.
  const mutateRef = useRef(mutate);
  mutateRef.current = mutate;

  useEffect(() => {
    if (status !== "authenticated" || !isNative()) return;
    if (pushRegistration) return;

    pushRegistration = registerPushNotifications(
      (token) => {
        currentPushToken = token;
        mutateRef.current(
          { token, platform: "android" },
          {
            onError: (err) => {
              console.error(
                "[PushNotifications] Failed to register device with server:",
                err.message,
              );
            },
          },
        );
      },
      (notification) => {
        if (notification.title && notification.body) {
          alert(`${notification.title}\n${notification.body}`);
        }
      },
    );
  }, [status]);

  useEffect(() => {
    if (status === "unauthenticated") void resetDeviceRegistration();
  }, [status]);
};
