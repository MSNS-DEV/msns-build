"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import {
  Fingerprint,
  KeyRound,
  Loader2,
  Mail,
  MessageSquare,
  Smartphone,
} from "lucide-react";
import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { toast } from "~/components/blocks/security/notify";
import { RedirectMap } from "~/constants";
import { AuthShell } from "~/components/blocks/security/AuthShell";
import {
  CodeInput,
  usePasskeySupport,
} from "~/components/blocks/security/shared";

type Method = "passkey" | "totp" | "sms" | "email" | "backup";

const LABELS: Record<Method, { label: string; icon: React.ReactNode }> = {
  passkey: { label: "Passkey", icon: <Fingerprint className="h-4 w-4" /> },
  totp: {
    label: "Authenticator app",
    icon: <Smartphone className="h-4 w-4" />,
  },
  sms: { label: "Text message", icon: <MessageSquare className="h-4 w-4" /> },
  email: { label: "Email", icon: <Mail className="h-4 w-4" /> },
  backup: { label: "Backup code", icon: <KeyRound className="h-4 w-4" /> },
};

export default function VerifyClient() {
  const router = useRouter();
  const { data: session, status, update } = useSession();
  const passkeySupport = usePasskeySupport();
  const pending = !!session?.user.twoFactorPending;

  const challenge = api.security.loginChallenge.useQuery(undefined, {
    enabled: status === "authenticated" && pending,
    retry: false,
  });

  const [method, setMethod] = useState<Method | null>(null);
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState("");
  const [remember, setRemember] = useState(false);
  const [codeSent, setCodeSent] = useState<Partial<Record<Method, boolean>>>(
    {},
  );
  const [finishing, setFinishing] = useState(false);

  const goHome = async () => {
    setFinishing(true);
    const fresh = await update();
    const user = fresh?.user ?? session?.user;
    if (user?.mustChangePassword) router.replace("/account/change-password");
    else if (user?.twoFactorEnrollRequired)
      router.replace("/account/security-setup");
    else router.replace(RedirectMap[user?.accountType ?? "NONE"] ?? "/");
    router.refresh();
  };

  // Not signed in, or nothing left to verify.
  useEffect(() => {
    if (status === "unauthenticated") router.replace("/sign-in");
    if (status === "authenticated" && !pending && !finishing) void goHome();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, pending]);

  const available = useMemo<Method[]>(() => {
    const m = challenge.data?.pending ? challenge.data.methods : null;
    if (!m) return [];
    const list: Method[] = [];
    if (m.passkey && passkeySupport.supported) list.push("passkey");
    if (m.totp) list.push("totp");
    if (m.sms) list.push("sms");
    if (m.email) list.push("email");
    if (m.backupCode) list.push("backup");
    return list;
  }, [challenge.data, passkeySupport.supported]);

  useEffect(() => {
    if (!method && available.length && passkeySupport.checked) {
      setMethod(available[0]!);
    }
  }, [available, method, passkeySupport.checked]);

  const onSuccess = () => {
    toast({ title: "Verified" });
    void goHome();
  };
  const onError = (err: { message: string }) => {
    setCode("");
    toast({
      title: "Verification failed",
      description: err.message,
      variant: "destructive",
    });
  };

  const verify = api.security.verifyLogin.useMutation({
    onSuccess: (r) => {
      if ("backupCodesLeft" in r && typeof r.backupCodesLeft === "number") {
        toast({
          title: `${r.backupCodesLeft} backup codes left`,
          description:
            "Create new ones in Profile → Security if you're running low.",
        });
      }
      onSuccess();
    },
    onError,
  });
  const sendCode = api.security.sendLoginCode.useMutation({
    onSuccess: (_r, vars) => {
      setCodeSent((s) => ({
        ...s,
        [vars.channel === "SMS" ? "sms" : "email"]: true,
      }));
      toast({ title: "Code sent" });
    },
    onError: (err) =>
      toast({
        title: "Couldn't send the code",
        description: err.message,
        variant: "destructive",
      }),
  });
  const passkeyOptions = api.security.passkeyStepUpOptions.useMutation();
  const passkeyVerify = api.security.passkeyStepUpVerify.useMutation();
  const [passkeyBusy, setPasskeyBusy] = useState(false);

  async function verifyWithPasskey() {
    setPasskeyBusy(true);
    try {
      const { startAuthentication } = await import("@simplewebauthn/browser");
      const { challengeId, options } = await passkeyOptions.mutateAsync();
      const response = await startAuthentication({ optionsJSON: options });
      await passkeyVerify.mutateAsync({ challengeId, response, remember });
      onSuccess();
    } catch (error) {
      const err = error as Error;
      if (err.name === "NotAllowedError") {
        toast({ title: "Passkey check was cancelled" });
      } else {
        onError(err);
      }
    } finally {
      setPasskeyBusy(false);
    }
  }

  const submitCode = (value: string) => {
    if (!method || method === "passkey" || method === "backup") return;
    verify.mutate({ method, code: value, remember });
  };

  if (
    status !== "authenticated" ||
    !pending ||
    challenge.isLoading ||
    finishing
  ) {
    return (
      <AuthShell title="Two-step verification">
        <div className="flex justify-center py-8">
          <Loader2
            className="h-6 w-6 animate-spin text-emerald-500"
            aria-label="Loading"
          />
        </div>
      </AuthShell>
    );
  }

  const methods = challenge.data?.pending ? challenge.data.methods : null;
  const busy = verify.isPending || passkeyBusy;

  return (
    <AuthShell
      title="Two-step verification"
      subtitle={
        <>
          Signing in as{" "}
          <strong>
            {challenge.data?.pending && challenge.data.displayName}
          </strong>
        </>
      }
    >
      {available.length === 0 ? (
        <p className="text-center text-sm text-muted-foreground">
          {passkeySupport.reason ??
            "No verification method is available on this device. Contact the school office to reset two-factor authentication."}
        </p>
      ) : (
        <div className="space-y-5">
          {available.length > 1 && (
            <div
              role="tablist"
              aria-label="Verification method"
              className="flex flex-wrap justify-center gap-1.5"
            >
              {available.map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={method === m}
                  onClick={() => {
                    setMethod(m);
                    setCode("");
                  }}
                  className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                    method === m
                      ? "border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : "border-border text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {LABELS[m].icon}
                  {LABELS[m].label}
                </button>
              ))}
            </div>
          )}

          {method === "passkey" && (
            <div className="space-y-3 text-center">
              <p className="text-sm text-muted-foreground">
                Use your fingerprint, face or screen lock.
              </p>
              <Button
                className="w-full"
                onClick={() => void verifyWithPasskey()}
                disabled={busy}
              >
                {passkeyBusy ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Fingerprint className="mr-2 h-4 w-4" />
                )}
                Verify with passkey
              </Button>
            </div>
          )}

          {method === "totp" && (
            <div className="flex flex-col items-center gap-3">
              <p className="text-center text-sm text-muted-foreground">
                Enter the 6-digit code from your authenticator app.
              </p>
              <CodeInput
                value={code}
                onChange={setCode}
                autoFocus
                disabled={busy}
                onComplete={submitCode}
              />
            </div>
          )}

          {(method === "sms" || method === "email") && (
            <div className="flex flex-col items-center gap-3">
              <p className="text-center text-sm text-muted-foreground">
                {method === "sms"
                  ? `We'll text a code to ${methods?.sms}.`
                  : `We'll email a code to ${methods?.email}.`}
              </p>
              {codeSent[method] && (
                <CodeInput
                  value={code}
                  onChange={setCode}
                  autoFocus
                  disabled={busy}
                  onComplete={submitCode}
                />
              )}
              <Button
                variant={codeSent[method] ? "ghost" : "default"}
                className={codeSent[method] ? "" : "w-full"}
                size={codeSent[method] ? "sm" : "default"}
                disabled={sendCode.isPending}
                onClick={() =>
                  sendCode.mutate({
                    channel: method === "sms" ? "SMS" : "EMAIL",
                  })
                }
              >
                {sendCode.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {codeSent[method] ? "Send a new code" : "Send code"}
              </Button>
            </div>
          )}

          {method === "backup" && (
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                verify.mutate({ method: "backup", code: backup, remember });
              }}
            >
              <Label htmlFor="backup-code" className="text-xs">
                One of your saved backup codes
              </Label>
              <Input
                id="backup-code"
                placeholder="XXXX-XXXX"
                autoComplete="off"
                value={backup}
                onChange={(e) => setBackup(e.target.value)}
                className="text-center font-mono tracking-widest"
                autoFocus
              />
              <Button
                type="submit"
                className="w-full"
                disabled={backup.length < 8 || busy}
              >
                {verify.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Verify
              </Button>
            </form>
          )}

          {method !== "passkey" && method !== "backup" && (
            <Button
              className="w-full"
              disabled={
                code.length !== 6 ||
                busy ||
                ((method === "sms" || method === "email") && !codeSent[method])
              }
              onClick={() => submitCode(code)}
            >
              {verify.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Verify
            </Button>
          )}

          <label className="flex cursor-pointer items-center justify-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={remember}
              onCheckedChange={(v) => setRemember(v === true)}
            />
            Remember this device for 30 days
          </label>
        </div>
      )}

      <div className="mt-6 border-t border-border pt-4 text-center">
        <Button
          variant="link"
          size="sm"
          className="text-xs text-muted-foreground"
          onClick={() => void signOut({ callbackUrl: "/sign-in" })}
        >
          Cancel and use a different account
        </Button>
      </div>
    </AuthShell>
  );
}
