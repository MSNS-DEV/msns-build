"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "~/components/ui/button";
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
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "~/components/ui/input-otp";

/**
 * Passkeys need WebAuthn. The Android app's WebView doesn't provide it, so
 * the passkey UI is hidden there (and in old browsers).
 */
export function usePasskeySupport() {
  const [state, setState] = useState<{
    checked: boolean;
    supported: boolean;
    reason?: string;
  }>({ checked: false, supported: false });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { Capacitor } = await import("@capacitor/core");
      if (Capacitor.isNativePlatform()) {
        if (!cancelled)
          setState({
            checked: true,
            supported: false,
            reason:
              "Passkeys aren't available inside the MSNS app. Open lms.msns.edu.pk in your phone's browser to add or use one.",
          });
        return;
      }
      const { browserSupportsWebAuthn } =
        await import("@simplewebauthn/browser");
      if (!cancelled)
        setState({
          checked: true,
          supported: browserSupportsWebAuthn(),
          reason: browserSupportsWebAuthn()
            ? undefined
            : "This browser doesn't support passkeys.",
        });
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

/** Six-digit code input with autofill from SMS where the browser supports it. */
export function CodeInput({
  value,
  onChange,
  onComplete,
  disabled,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  onComplete?: (v: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <InputOTP
      maxLength={6}
      value={value}
      onChange={(v) => onChange(v.replace(/\D/g, ""))}
      onComplete={onComplete}
      disabled={disabled}
      autoFocus={autoFocus}
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="^[0-9]*$"
      aria-label="6-digit code"
    >
      <InputOTPGroup>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <InputOTPSlot key={i} index={i} className="h-11 w-10 text-lg" />
        ))}
      </InputOTPGroup>
    </InputOTP>
  );
}

/** Asks for the current password before a sensitive change. */
export function PasswordPrompt({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  destructive,
  pending,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  destructive?: boolean;
  pending?: boolean;
  onCancel: () => void;
  onConfirm: (password: string) => void;
}) {
  const [password, setPassword] = useState("");
  useEffect(() => {
    if (!open) setPassword("");
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (password) onConfirm(password);
          }}
          className="space-y-4"
        >
          <div className="space-y-1.5">
            <Label htmlFor="reauth-password">Current password</Label>
            <Input
              id="reauth-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={destructive ? "destructive" : "default"}
              disabled={!password || pending}
            >
              {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Rough device label from a user-agent string. */
export function describeDevice(ua: string | null | undefined): string {
  if (!ua) return "Unknown device";
  const has = (s: string) => ua.includes(s);
  const browser = has("Edg/")
    ? "Edge"
    : has("OPR/")
      ? "Opera"
      : has("Chrome/")
        ? "Chrome"
        : has("Firefox/")
          ? "Firefox"
          : has("Safari/")
            ? "Safari"
            : "Browser";
  const os = has("Android")
    ? "Android"
    : has("iPhone") || has("iPad")
      ? "iOS"
      : has("Windows")
        ? "Windows"
        : has("Mac OS X")
          ? "macOS"
          : has("Linux")
            ? "Linux"
            : "";
  const app = has("; wv)") ? " (MSNS app)" : "";
  return `${browser}${os ? ` on ${os}` : ""}${app}`;
}

const EVENT_LABELS: Record<string, string> = {
  "login.success": "Signed in",
  "login.passkey": "Signed in with a passkey",
  "login.password_ok_2fa_pending": "Password accepted, waiting for 2FA",
  "login.failed": "Failed sign-in (wrong password)",
  "login.blocked_suspended": "Sign-in blocked (account suspended)",
  "mfa.failed": "Wrong two-factor code",
  "mfa.code_sent": "Sign-in code sent",
  "mfa.backup_code_used": "Backup code used",
  "mfa.totp_enabled": "Authenticator app turned on",
  "mfa.totp_disabled": "Authenticator app turned off",
  "mfa.sms_enabled": "SMS codes turned on",
  "mfa.sms_disabled": "SMS codes turned off",
  "mfa.email_enabled": "Email codes turned on",
  "mfa.email_disabled": "Email codes turned off",
  "mfa.passkey_added": "Passkey added",
  "mfa.passkey_removed": "Passkey removed",
  "mfa.backup_codes_regenerated": "New backup codes created",
  "mfa.trusted_devices_cleared": "Remembered devices forgotten",
  "password.changed": "Password changed",
  "session.revoked": "A device was signed out",
  "session.revoked_others": "Other devices signed out",
  "session.signed_out_everywhere": "Signed out everywhere",
  "admin.role_changed": "Role changed by an administrator",
  "admin.suspended": "Suspended by an administrator",
  "admin.reactivated": "Reactivated by an administrator",
  "admin.unlocked": "Unlocked by an administrator",
  "admin.password_reset": "Password reset by an administrator",
  "admin.two_factor_reset": "2FA reset by an administrator",
  "admin.sessions_revoked": "Signed out by an administrator",
};

export function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? type;
}

export const isWarningEvent = (type: string) =>
  type === "login.failed" ||
  type === "mfa.failed" ||
  type === "login.blocked_suspended" ||
  type.startsWith("admin.");

export function formatWhen(date: Date | string | null | undefined): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-PK", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Karachi",
  }).format(new Date(date));
}
