"use client";

import { useState } from "react";
import { signOut, useSession } from "next-auth/react";
import {
  Activity,
  AlertTriangle,
  Eye,
  EyeOff,
  Laptop,
  Loader2,
  Lock,
  LogOut,
  ShieldCheck,
  ShieldAlert,
} from "lucide-react";
import { api } from "~/trpc/react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Skeleton } from "~/components/ui/skeleton";
import { toast } from "~/hooks/use-toast";
import {
  describeDevice,
  eventLabel,
  formatWhen,
  isWarningEvent,
  PasswordPrompt,
} from "./shared";
import {
  BackupCodesCard,
  BackupCodesDialog,
  EmailCodeCard,
  PasskeysCard,
  SmsCard,
  TotpCard,
} from "./TwoFactorCards";

const onError = (err: { message: string }) =>
  toast({
    title: "Something went wrong",
    description: err.message,
    variant: "destructive",
  });

async function fullSignOut() {
  const { clearDeviceAuthSession } = await import("~/lib/mobile/device-auth");
  await clearDeviceAuthSession().catch(() => undefined);
  await signOut({ redirect: true, callbackUrl: "/sign-in" });
}

// ─── Password ──────────────────────────────────────────────────────────

export function ChangePasswordForm({
  required,
  onChanged,
}: {
  required?: boolean;
  onChanged?: () => void;
}) {
  const { update } = useSession();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const change = api.security.changePassword.useMutation({
    onSuccess: async (r) => {
      toast({
        title: "Password changed",
        description:
          r.otherSessionsSignedOut > 0
            ? `${r.otherSessionsSignedOut} other device(s) were signed out.`
            : undefined,
      });
      setCurrent("");
      setNext("");
      setConfirm("");
      await update();
      onChanged?.();
    },
    onError,
  });
  const mismatch = confirm.length > 0 && next !== confirm;
  const weak =
    next.length > 0 &&
    (next.length < 8 || !/[A-Za-z]/.test(next) || !/\d/.test(next));

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!mismatch && !weak)
          change.mutate({ currentPassword: current, newPassword: next });
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="pw-current" className="text-xs">
          {required ? "Current (temporary) password" : "Current password"}
        </Label>
        <Input
          id="pw-current"
          type={show ? "text" : "password"}
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="pw-new" className="text-xs">
            New password
          </Label>
          <Input
            id="pw-new"
            type={show ? "text" : "password"}
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            aria-invalid={weak}
            aria-describedby="pw-hint"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pw-confirm" className="text-xs">
            Confirm new password
          </Label>
          <Input
            id="pw-confirm"
            type={show ? "text" : "password"}
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            aria-invalid={mismatch}
          />
        </div>
      </div>
      <p
        id="pw-hint"
        className={`text-xs ${weak || mismatch ? "text-destructive" : "text-muted-foreground"}`}
      >
        {mismatch
          ? "The passwords don't match."
          : "At least 8 characters, with letters and numbers. Don't reuse your ID or email."}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={!current || !next || mismatch || weak || change.isPending}
        >
          {change.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Lock className="mr-2 h-4 w-4" />
          )}
          {required ? "Set new password" : "Update password"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setShow((s) => !s)}
        >
          {show ? (
            <EyeOff className="mr-2 h-4 w-4" />
          ) : (
            <Eye className="mr-2 h-4 w-4" />
          )}
          {show ? "Hide" : "Show"} passwords
        </Button>
      </div>
    </form>
  );
}

// ─── Main section ──────────────────────────────────────────────────────

export default function SecuritySettings({
  /** Enrolment mode: only the 2FA methods, with an explanation. */
  enrollment,
  onEnrolled,
}: {
  enrollment?: boolean;
  onEnrolled?: () => void;
}) {
  const utils = api.useUtils();
  const { update } = useSession();
  const { data, isLoading, error } = api.security.overview.useQuery();
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [confirmEverywhere, setConfirmEverywhere] = useState(false);

  const refresh = () => {
    void utils.security.overview.invalidate();
    // Session flags (e.g. "2FA enrolment required") are re-read from the server.
    void update().then(() => onEnrolled?.());
  };

  const revoke = api.security.revokeSession.useMutation({
    onSuccess: (r) => {
      if (r.current) void fullSignOut();
      else {
        toast({ title: "Device signed out" });
        void utils.security.overview.invalidate();
      }
    },
    onError,
  });
  const revokeOthers = api.security.revokeOtherSessions.useMutation({
    onSuccess: (r) => {
      toast({ title: `${r.count} other device(s) signed out` });
      void utils.security.overview.invalidate();
    },
    onError,
  });
  const everywhere = api.security.signOutEverywhere.useMutation({
    onSuccess: () => void fullSignOut(),
    onError,
  });
  const forgetDevices = api.security.forgetTrustedDevices.useMutation({
    onSuccess: () =>
      toast({
        title: "Remembered devices forgotten",
        description: "Every device will ask for your second factor next time.",
      }),
    onError,
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-28 rounded-2xl" />
        <Skeleton className="h-40 rounded-2xl" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Security settings couldn&apos;t be loaded. {error?.message}
        </CardContent>
      </Card>
    );
  }

  const cardProps = { data, onChanged: refresh, onBackupCodes: setBackupCodes };

  return (
    <section aria-labelledby="security-heading" className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="security-heading"
            className="flex items-center gap-2 text-lg font-semibold"
          >
            {data.has2fa ? (
              <ShieldCheck className="h-5 w-5 text-emerald-500" />
            ) : (
              <ShieldAlert className="h-5 w-5 text-amber-500" />
            )}
            {enrollment ? "Set up two-factor authentication" : "Security"}
          </h2>
          <p className="text-sm text-muted-foreground">
            {data.has2fa
              ? "Two-factor authentication is on. New devices need your password and a second step."
              : "Add a second step at sign-in so a stolen password isn't enough to get into your account."}
          </p>
        </div>
        <Badge
          variant="outline"
          className={
            data.has2fa
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
          }
        >
          2FA {data.has2fa ? "on" : "off"}
        </Badge>
      </div>

      {data.policyRequires2fa && !data.has2fa && (
        <div className="flex gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            The school requires two-factor authentication for{" "}
            <strong>{data.account.role.toLowerCase()}</strong> accounts. Turn on
            at least one method below to continue using the portal.
          </p>
        </div>
      )}

      {!enrollment && (
        <Card className="border-border bg-card shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Lock className="h-4 w-4 text-amber-500" /> Password
            </CardTitle>
            <CardDescription className="text-xs">
              Changing your password signs out your other devices.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChangePasswordForm />
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <PasskeysCard {...cardProps} />
        <TotpCard {...cardProps} />
        <SmsCard {...cardProps} />
        <EmailCodeCard {...cardProps} />
        <BackupCodesCard {...cardProps} />
      </div>

      {!enrollment && (
        <>
          <Card className="border-border bg-card shadow-sm">
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
              <div className="space-y-1">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Laptop className="h-4 w-4 text-sky-500" /> Where you&apos;re
                  signed in
                </CardTitle>
                <CardDescription className="text-xs">
                  Sign out any device you don&apos;t recognise, then change your
                  password.
                </CardDescription>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={revokeOthers.isPending || data.sessions.length < 2}
                  onClick={() => revokeOthers.mutate()}
                >
                  Sign out other devices
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => setConfirmEverywhere(true)}
                >
                  <LogOut className="mr-2 h-4 w-4" /> Sign out everywhere
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <ul className="divide-y divide-border rounded-lg border border-border">
                {data.sessions.map((s) => (
                  <li
                    key={s.id}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 font-medium">
                        {describeDevice(s.userAgent)}
                        {s.current && (
                          <Badge variant="outline" className="text-[10px]">
                            This device
                          </Badge>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Active {formatWhen(s.lastSeenAt)} · signed in{" "}
                        {formatWhen(s.createdAt)}
                        {s.ip && ` · ${s.ip}`}
                        {s.method && ` · ${s.method.replace("+", " + ")}`}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate({ id: s.id })}
                    >
                      {s.current ? "Sign out" : "Remove"}
                    </Button>
                  </li>
                ))}
              </ul>
              {data.has2fa && (
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>
                    Devices where you ticked &ldquo;Remember this device&rdquo;
                    skip the second step for 30 days.
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={forgetDevices.isPending}
                    onClick={() => forgetDevices.mutate()}
                  >
                    Forget remembered devices
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-border bg-card shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Activity className="h-4 w-4 text-violet-500" /> Recent security
                activity
              </CardTitle>
              <CardDescription className="text-xs">
                Times shown in Pakistan time.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.events.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No activity yet.
                </p>
              ) : (
                <ul className="space-y-2">
                  {data.events.map((e) => (
                    <li
                      key={e.id}
                      className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm"
                    >
                      <span
                        className={
                          isWarningEvent(e.type)
                            ? "font-medium text-amber-700 dark:text-amber-400"
                            : ""
                        }
                      >
                        {eventLabel(e.type)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {formatWhen(e.createdAt)}
                        {e.userAgent && ` · ${describeDevice(e.userAgent)}`}
                        {e.ip && ` · ${e.ip}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <BackupCodesDialog
        codes={backupCodes}
        onClose={() => setBackupCodes(null)}
      />
      <PasswordPrompt
        open={confirmEverywhere}
        title="Sign out everywhere?"
        description="Every device, including this one, will be signed out and remembered devices forgotten."
        confirmLabel="Sign out everywhere"
        destructive
        pending={everywhere.isPending}
        onCancel={() => setConfirmEverywhere(false)}
        onConfirm={(password) => everywhere.mutate({ password })}
      />
    </section>
  );
}
