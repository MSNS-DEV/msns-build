"use client";

import Image from "next/image";
import { useState } from "react";
import {
  CheckCircle2,
  Copy,
  Download,
  Fingerprint,
  KeyRound,
  Loader2,
  Mail,
  MessageSquare,
  Pencil,
  Smartphone,
  Trash2,
} from "lucide-react";
import { api, type RouterOutputs } from "~/trpc/react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { toast } from "~/hooks/use-toast";
import {
  CodeInput,
  formatWhen,
  PasswordPrompt,
  usePasskeySupport,
} from "./shared";

type Overview = RouterOutputs["security"]["overview"];

const onError = (err: { message: string }) =>
  toast({
    title: "Something went wrong",
    description: err.message,
    variant: "destructive",
  });

function StatusBadge({ on }: { on: boolean }) {
  return on ? (
    <Badge
      className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      variant="outline"
    >
      <CheckCircle2 className="mr-1 h-3 w-3" /> On
    </Badge>
  ) : (
    <Badge variant="outline" className="text-muted-foreground">
      Off
    </Badge>
  );
}

function MethodCard({
  icon,
  title,
  description,
  on,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  on: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card className="border-border bg-card shadow-sm">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            {icon}
            {title}
          </CardTitle>
          <CardDescription className="text-xs">{description}</CardDescription>
        </div>
        <StatusBadge on={on} />
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  );
}

// ─── Backup codes dialog (shown once) ──────────────────────────────────

export function BackupCodesDialog({
  codes,
  onClose,
}: {
  codes: string[] | null;
  onClose: () => void;
}) {
  const text = codes?.join("\n") ?? "";
  return (
    <Dialog open={!!codes} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save your backup codes</DialogTitle>
          <DialogDescription>
            Each code works once if you lose your phone or passkey. Store them
            somewhere safe — they won&apos;t be shown again.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-muted/40 p-4 font-mono text-sm">
          {codes?.map((c) => (
            <span key={c} className="tracking-wider">
              {c}
            </span>
          ))}
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            onClick={() => {
              void navigator.clipboard.writeText(text);
              toast({ title: "Backup codes copied" });
            }}
          >
            <Copy className="mr-2 h-4 w-4" /> Copy
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              const blob = new Blob([`MSNS LMS backup codes\n\n${text}\n`], {
                type: "text/plain",
              });
              const a = document.createElement("a");
              a.href = URL.createObjectURL(blob);
              a.download = "msns-backup-codes.txt";
              a.click();
              URL.revokeObjectURL(a.href);
            }}
          >
            <Download className="mr-2 h-4 w-4" /> Download
          </Button>
          <Button onClick={onClose}>I&apos;ve saved them</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Authenticator app ─────────────────────────────────────────────────

export function TotpCard({
  data,
  onChanged,
  onBackupCodes,
}: {
  data: Overview;
  onChanged: () => void;
  onBackupCodes: (codes: string[]) => void;
}) {
  const [setup, setSetup] = useState<{
    secret: string;
    qrDataUrl: string;
  } | null>(null);
  const [code, setCode] = useState("");
  const [confirmOff, setConfirmOff] = useState(false);

  const begin = api.security.totpBegin.useMutation({
    onSuccess: (r) => {
      setSetup({ secret: r.secret, qrDataUrl: r.qrDataUrl });
      setCode("");
    },
    onError,
  });
  const enable = api.security.totpEnable.useMutation({
    onSuccess: (r) => {
      toast({ title: "Authenticator app turned on" });
      setSetup(null);
      onChanged();
      if (r.backupCodes) onBackupCodes(r.backupCodes);
    },
    onError: (e) => {
      setCode("");
      onError(e);
    },
  });
  const disable = api.security.totpDisable.useMutation({
    onSuccess: () => {
      toast({ title: "Authenticator app turned off" });
      setConfirmOff(false);
      onChanged();
    },
    onError,
  });

  return (
    <MethodCard
      icon={<Smartphone className="h-4 w-4 text-indigo-500" />}
      title="Authenticator app"
      description="Google Authenticator, Microsoft Authenticator, Authy or any TOTP app. Works offline."
      on={data.totp.enabled}
    >
      {data.totp.enabled ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>Turned on {formatWhen(data.totp.enabledAt)}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmOff(true)}
          >
            Turn off
          </Button>
        </div>
      ) : setup ? (
        <div className="space-y-4">
          <ol className="list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
            <li>Open your authenticator app and add an account.</li>
            <li>Scan this QR code, or enter the key by hand.</li>
            <li>Type the 6-digit code the app shows.</li>
          </ol>
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
            <Image
              src={setup.qrDataUrl}
              alt="QR code for your authenticator app"
              width={160}
              height={160}
              unoptimized
              className="rounded-lg border border-border bg-white p-1"
            />
            <div className="w-full space-y-2">
              <Label className="text-xs">Setup key</Label>
              <div className="flex items-center gap-2">
                <code className="break-all rounded bg-muted px-2 py-1 font-mono text-xs">
                  {setup.secret.match(/.{1,4}/g)?.join(" ")}
                </code>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Copy setup key"
                  onClick={() =>
                    void navigator.clipboard.writeText(setup.secret)
                  }
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <Label className="pt-2 text-xs">Code from the app</Label>
              <CodeInput
                value={code}
                onChange={setCode}
                disabled={enable.isPending}
                onComplete={(c) => enable.mutate({ code: c })}
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={code.length !== 6 || enable.isPending}
              onClick={() => enable.mutate({ code })}
            >
              {enable.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Verify and turn on
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSetup(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          size="sm"
          onClick={() => begin.mutate()}
          disabled={begin.isPending}
        >
          {begin.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Set up authenticator app
        </Button>
      )}
      <PasswordPrompt
        open={confirmOff}
        title="Turn off the authenticator app?"
        description="Enter your password to confirm."
        confirmLabel="Turn off"
        destructive
        pending={disable.isPending}
        onCancel={() => setConfirmOff(false)}
        onConfirm={(password) => disable.mutate({ password })}
      />
    </MethodCard>
  );
}

// ─── SMS ───────────────────────────────────────────────────────────────

export function SmsCard({
  data,
  onChanged,
  onBackupCodes,
}: {
  data: Overview;
  onChanged: () => void;
  onBackupCodes: (codes: string[]) => void;
}) {
  const [phone, setPhone] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [confirmOff, setConfirmOff] = useState(false);

  const start = api.security.phoneStart.useMutation({
    onSuccess: (r) => {
      setSentTo(r.sentTo);
      setCode("");
      toast({ title: `Code sent to ${r.sentTo}` });
    },
    onError,
  });
  const verify = api.security.phoneVerify.useMutation({
    onSuccess: (r) => {
      toast({ title: "SMS codes turned on" });
      setSentTo(null);
      setPhone("");
      onChanged();
      if (r.backupCodes) onBackupCodes(r.backupCodes);
    },
    onError: (e) => {
      setCode("");
      onError(e);
    },
  });
  const disable = api.security.smsDisable.useMutation({
    onSuccess: () => {
      toast({ title: "SMS codes turned off" });
      setConfirmOff(false);
      onChanged();
    },
    onError,
  });

  const unavailable = !data.channels.sms && !data.sms.enabled;

  return (
    <MethodCard
      icon={<MessageSquare className="h-4 w-4 text-sky-500" />}
      title="Text message (SMS)"
      description="Get a 6-digit code by SMS when you sign in on a new device."
      on={data.sms.enabled}
    >
      {data.sms.enabled ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>Codes go to {data.sms.phone}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmOff(true)}
          >
            Turn off
          </Button>
        </div>
      ) : unavailable ? (
        <p className="text-xs text-muted-foreground">
          SMS isn&apos;t available yet. Ask the school office, or use an
          authenticator app.
        </p>
      ) : sentTo ? (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Enter the code we sent to {sentTo}.
          </p>
          <CodeInput
            value={code}
            onChange={setCode}
            autoFocus
            disabled={verify.isPending}
            onComplete={(c) => verify.mutate({ code: c })}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={code.length !== 6 || verify.isPending}
              onClick={() => verify.mutate({ code })}
            >
              {verify.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Verify
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={start.isPending}
              onClick={() =>
                start.mutate(phone ? { phone } : { useNumberOnFile: true })
              }
            >
              Resend
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSentTo(null)}>
              Change number
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            start.mutate({ phone });
          }}
        >
          <Label htmlFor="sms-phone" className="text-xs">
            Mobile number
          </Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="sms-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="0300 1234567"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="sm:max-w-xs"
            />
            <Button
              type="submit"
              size="sm"
              disabled={!phone || start.isPending}
            >
              {start.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Send code
            </Button>
          </div>
          {data.sms.numberOnFile && (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              disabled={start.isPending}
              onClick={() => start.mutate({ useNumberOnFile: true })}
            >
              Use the number on file ({data.sms.numberOnFile})
            </Button>
          )}
        </form>
      )}
      <PasswordPrompt
        open={confirmOff}
        title="Turn off SMS codes?"
        description="Your number will be removed. Enter your password to confirm."
        confirmLabel="Turn off"
        destructive
        pending={disable.isPending}
        onCancel={() => setConfirmOff(false)}
        onConfirm={(password) => disable.mutate({ password })}
      />
    </MethodCard>
  );
}

// ─── Email codes ───────────────────────────────────────────────────────

export function EmailCodeCard({
  data,
  onChanged,
  onBackupCodes,
}: {
  data: Overview;
  onChanged: () => void;
  onBackupCodes: (codes: string[]) => void;
}) {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [confirmOff, setConfirmOff] = useState(false);

  const start = api.security.emailStart.useMutation({
    onSuccess: (r) => {
      setSentTo(r.sentTo);
      setCode("");
      toast({ title: `Code sent to ${r.sentTo}` });
    },
    onError,
  });
  const verify = api.security.emailVerify.useMutation({
    onSuccess: (r) => {
      toast({ title: "Email codes turned on" });
      setSentTo(null);
      onChanged();
      if (r.backupCodes) onBackupCodes(r.backupCodes);
    },
    onError: (e) => {
      setCode("");
      onError(e);
    },
  });
  const disable = api.security.emailDisable.useMutation({
    onSuccess: () => {
      toast({ title: "Email codes turned off" });
      setConfirmOff(false);
      onChanged();
    },
    onError,
  });

  if (!data.channels.email && !data.email.enabled) return null;

  return (
    <MethodCard
      icon={<Mail className="h-4 w-4 text-amber-500" />}
      title="Email codes"
      description="Get a 6-digit code at an email address you check. Use a personal address you can reach."
      on={data.email.enabled}
    >
      {data.email.enabled ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>Codes go to {data.email.address}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmOff(true)}
          >
            Turn off
          </Button>
        </div>
      ) : sentTo ? (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Enter the code we sent to {sentTo}.
          </p>
          <CodeInput
            value={code}
            onChange={setCode}
            autoFocus
            disabled={verify.isPending}
            onComplete={(c) => verify.mutate({ code: c })}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={code.length !== 6 || verify.isPending}
              onClick={() => verify.mutate({ code })}
            >
              Verify
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSentTo(null)}>
              Change address
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            start.mutate({ email });
          }}
        >
          <Input
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="sm:max-w-xs"
            aria-label="Email address for codes"
          />
          <Button type="submit" size="sm" disabled={!email || start.isPending}>
            {start.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Send code
          </Button>
        </form>
      )}
      <PasswordPrompt
        open={confirmOff}
        title="Turn off email codes?"
        description="Enter your password to confirm."
        confirmLabel="Turn off"
        destructive
        pending={disable.isPending}
        onCancel={() => setConfirmOff(false)}
        onConfirm={(password) => disable.mutate({ password })}
      />
    </MethodCard>
  );
}

// ─── Passkeys ──────────────────────────────────────────────────────────

export function PasskeysCard({
  data,
  onChanged,
  onBackupCodes,
}: {
  data: Overview;
  onChanged: () => void;
  onBackupCodes: (codes: string[]) => void;
}) {
  const support = usePasskeySupport();
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [removing, setRemoving] = useState<string | null>(null);

  const options = api.security.passkeyRegisterOptions.useMutation();
  const verify = api.security.passkeyRegisterVerify.useMutation();
  const rename = api.security.passkeyRename.useMutation({
    onSuccess: () => {
      setRenaming(null);
      onChanged();
    },
    onError,
  });
  const remove = api.security.passkeyDelete.useMutation({
    onSuccess: () => {
      toast({ title: "Passkey removed" });
      setRemoving(null);
      onChanged();
    },
    onError,
  });

  async function addPasskey() {
    setBusy(true);
    try {
      const { startRegistration } = await import("@simplewebauthn/browser");
      const { challengeId, options: optionsJSON } = await options.mutateAsync();
      const response = await startRegistration({ optionsJSON });
      const result = await verify.mutateAsync({
        challengeId,
        response,
        name: name.trim() || "Passkey",
      });
      toast({ title: "Passkey added" });
      setAdding(false);
      setName("");
      onChanged();
      if (result.backupCodes) onBackupCodes(result.backupCodes);
    } catch (error) {
      const err = error as Error;
      if (err.name === "NotAllowedError") {
        toast({ title: "Passkey setup was cancelled" });
      } else if (err.name === "InvalidStateError") {
        toast({
          title: "This device already has a passkey for your account",
          variant: "destructive",
        });
      } else {
        onError(err);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <MethodCard
      icon={<Fingerprint className="h-4 w-4 text-emerald-500" />}
      title="Passkeys"
      description="Sign in with your fingerprint, face or screen lock. Phishing-resistant and no codes to type."
      on={data.passkeys.length > 0}
    >
      {data.passkeys.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {data.passkeys.map((p) => (
            <li
              key={p.id}
              className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
            >
              {renaming?.id === p.id ? (
                <form
                  className="flex flex-1 gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    rename.mutate(renaming);
                  }}
                >
                  <Input
                    value={renaming.name}
                    onChange={(e) =>
                      setRenaming({ id: p.id, name: e.target.value })
                    }
                    maxLength={60}
                    className="h-8"
                    autoFocus
                    aria-label="Passkey name"
                  />
                  <Button size="sm" type="submit" disabled={rename.isPending}>
                    Save
                  </Button>
                </form>
              ) : (
                <div className="min-w-0">
                  <p className="truncate font-medium">{p.name}</p>
                  <p className="text-xs text-muted-foreground">
                    Added {formatWhen(p.createdAt)}
                    {p.lastUsedAt && ` · last used ${formatWhen(p.lastUsedAt)}`}
                    {p.backedUp && " · synced"}
                  </p>
                </div>
              )}
              {renaming?.id !== p.id && (
                <div className="flex gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Rename ${p.name}`}
                    onClick={() => setRenaming({ id: p.id, name: p.name })}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove ${p.name}`}
                    onClick={() => setRemoving(p.id)}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {!support.checked ? null : !support.supported ? (
        <p className="text-xs text-muted-foreground">{support.reason}</p>
      ) : adding ? (
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            void addPasskey();
          }}
        >
          <Input
            placeholder="Name, e.g. My phone"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            className="sm:max-w-xs"
            aria-label="Passkey name"
            autoFocus
          />
          <Button type="submit" size="sm" disabled={busy}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create passkey
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setAdding(false)}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <KeyRound className="mr-2 h-4 w-4" /> Add a passkey
        </Button>
      )}
      <PasswordPrompt
        open={!!removing}
        title="Remove this passkey?"
        description="You won't be able to sign in with it any more. Enter your password to confirm."
        confirmLabel="Remove"
        destructive
        pending={remove.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={(password) =>
          removing && remove.mutate({ id: removing, password })
        }
      />
    </MethodCard>
  );
}

// ─── Backup codes ──────────────────────────────────────────────────────

export function BackupCodesCard({
  data,
  onChanged,
  onBackupCodes,
}: {
  data: Overview;
  onChanged: () => void;
  onBackupCodes: (codes: string[]) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const regenerate = api.security.backupCodesRegenerate.useMutation({
    onSuccess: (r) => {
      setConfirm(false);
      onChanged();
      onBackupCodes(r.codes);
    },
    onError,
  });
  if (!data.has2fa) return null;
  const low = data.backupCodesRemaining <= 3;
  return (
    <MethodCard
      icon={<KeyRound className="h-4 w-4 text-slate-500" />}
      title="Backup codes"
      description="One-time codes for when you can't use your phone or passkey."
      on={data.backupCodesRemaining > 0}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span
          className={
            low
              ? "font-medium text-amber-600 dark:text-amber-400"
              : "text-muted-foreground"
          }
        >
          {data.backupCodesRemaining} of 10 codes left
          {low && " — create new ones soon"}
        </span>
        <Button size="sm" variant="outline" onClick={() => setConfirm(true)}>
          Create new codes
        </Button>
      </div>
      <PasswordPrompt
        open={confirm}
        title="Create new backup codes?"
        description="Your old codes will stop working. Enter your password to continue."
        confirmLabel="Create codes"
        pending={regenerate.isPending}
        onCancel={() => setConfirm(false)}
        onConfirm={(password) => regenerate.mutate({ password })}
      />
    </MethodCard>
  );
}
