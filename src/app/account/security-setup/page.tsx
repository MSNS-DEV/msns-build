"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { ArrowRight, Loader2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { RedirectMap } from "~/constants";
import { AuthShell } from "~/components/blocks/security/AuthShell";
import SecuritySettings from "~/components/blocks/security/SecuritySettings";

/** Shown when the school requires 2FA for this role and none is set up yet. */
export default function SecuritySetupPage() {
  const router = useRouter();
  const { data: session, status } = useSession();

  useEffect(() => {
    if (status === "unauthenticated") router.replace("/sign-in");
  }, [status, router]);

  // Only the first load shows a spinner; session refreshes must not unmount the form.
  if (!session) {
    return (
      <AuthShell title="Set up two-factor authentication">
        <div className="flex justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" />
        </div>
      </AuthShell>
    );
  }

  const done = !session.user.twoFactorEnrollRequired;
  const home = RedirectMap[session.user.accountType] ?? "/";

  return (
    <AuthShell
      wide
      title="Protect your account"
      subtitle="Choose at least one way to confirm it's you when you sign in on a new device."
    >
      <SecuritySettings enrollment />
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <Button
          variant="link"
          size="sm"
          className="text-xs text-muted-foreground"
          onClick={() => void signOut({ callbackUrl: "/sign-in" })}
        >
          Sign out
        </Button>
        <Button
          disabled={!done}
          onClick={() => {
            router.replace(home);
            router.refresh();
          }}
        >
          Continue to the portal <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </AuthShell>
  );
}
