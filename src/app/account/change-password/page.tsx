"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { Loader2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { RedirectMap } from "~/constants";
import { AuthShell } from "~/components/blocks/security/AuthShell";
import { ChangePasswordForm } from "~/components/blocks/security/SecuritySettings";

export default function ForcedChangePasswordPage() {
  const router = useRouter();
  const { data: session, status } = useSession();

  useEffect(() => {
    if (status === "unauthenticated") router.replace("/sign-in");
  }, [status, router]);

  const next = () => {
    const user = session?.user;
    if (user?.twoFactorEnrollRequired)
      router.replace("/account/security-setup");
    else router.replace(RedirectMap[user?.accountType ?? "NONE"] ?? "/");
    router.refresh();
  };

  // Only the first load shows a spinner; session refreshes must not unmount the form.
  if (!session) {
    return (
      <AuthShell title="Change your password">
        <div className="flex justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" />
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Choose a new password"
      subtitle={
        session.user.mustChangePassword
          ? "Your account is using a temporary or default password. Set your own before continuing."
          : "Update your password."
      }
    >
      <ChangePasswordForm required onChanged={next} />
      <div className="mt-6 border-t border-border pt-4 text-center">
        <Button
          variant="link"
          size="sm"
          className="text-xs text-muted-foreground"
          onClick={() => void signOut({ callbackUrl: "/sign-in" })}
        >
          Sign out
        </Button>
      </div>
    </AuthShell>
  );
}
