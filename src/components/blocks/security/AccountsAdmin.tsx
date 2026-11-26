"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import {
  Ban,
  Copy,
  KeyRound,
  Loader2,
  LockOpen,
  LogOut,
  Search,
  ShieldCheck,
  ShieldOff,
  UserCheck,
  Users,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "~/components/ui/sheet";
import { Skeleton } from "~/components/ui/skeleton";
import { Switch } from "~/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Textarea } from "~/components/ui/textarea";
import { toast } from "~/components/blocks/security/notify";
import {
  describeDevice,
  eventLabel,
  formatWhen,
  isWarningEvent,
} from "./shared";

type Row = RouterOutputs["accounts"]["list"]["rows"][number];
type Target = { id: string; type: "USER" | "PARENT" };

const ROLES = [
  "ADMIN",
  "PRINCIPAL",
  "HEAD",
  "CLERK",
  "TEACHER",
  "WORKER",
  "STUDENT",
] as const;
const EMPLOYEE_ROLES = [
  "ADMIN",
  "PRINCIPAL",
  "HEAD",
  "CLERK",
  "TEACHER",
  "WORKER",
] as const;

const onError = (err: { message: string }) =>
  toast({
    title: "Action failed",
    description: err.message,
    variant: "destructive",
  });

function StatusBadges({
  row,
}: {
  row: Pick<Row, "isActive" | "locked" | "twoFactor">;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {row.isActive ? (
        <Badge
          variant="outline"
          className="border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
        >
          Active
        </Badge>
      ) : (
        <Badge
          variant="outline"
          className="border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400"
        >
          Suspended
        </Badge>
      )}
      {row.locked && (
        <Badge
          variant="outline"
          className="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
        >
          Locked
        </Badge>
      )}
      {row.twoFactor ? (
        <Badge
          variant="outline"
          className="border-sky-500/30 text-sky-600 dark:text-sky-400"
        >
          <ShieldCheck className="mr-1 h-3 w-3" /> 2FA
        </Badge>
      ) : (
        <Badge variant="outline" className="text-muted-foreground">
          No 2FA
        </Badge>
      )}
    </div>
  );
}

// ─── Account detail ────────────────────────────────────────────────────

function AccountSheet({
  target,
  onClose,
  canGrantAdmin,
}: {
  target: Target | null;
  onClose: () => void;
  canGrantAdmin: boolean;
}) {
  const utils = api.useUtils();
  const { data, isLoading } = api.accounts.get.useQuery(target!, {
    enabled: !!target,
  });
  const [confirm, setConfirm] = useState<
    null | "suspend" | "reset2fa" | "resetPassword" | "revoke"
  >(null);
  const [reason, setReason] = useState("");
  const [tempPassword, setTempPassword] = useState<string | null>(null);

  const done = (title: string) => {
    toast({ title });
    setConfirm(null);
    setReason("");
    void utils.accounts.invalidate();
  };

  const setActive = api.accounts.setActive.useMutation({
    onSuccess: (_r, v) =>
      done(v.active ? "Account reactivated" : "Account suspended"),
    onError,
  });
  const unlock = api.accounts.unlock.useMutation({
    onSuccess: () => done("Account unlocked"),
    onError,
  });
  const resetPassword = api.accounts.forcePasswordReset.useMutation({
    onSuccess: (r) => {
      setTempPassword(r.temporaryPassword);
      done("Temporary password created");
    },
    onError,
  });
  const reset2fa = api.accounts.resetTwoFactor.useMutation({
    onSuccess: () => done("Two-factor authentication reset"),
    onError,
  });
  const revoke = api.accounts.revokeSessions.useMutation({
    onSuccess: () => done("Signed out of every device"),
    onError,
  });
  const setRole = api.accounts.setRole.useMutation({
    onSuccess: () => done("Role updated"),
    onError,
  });

  const busy =
    setActive.isPending ||
    resetPassword.isPending ||
    reset2fa.isPending ||
    revoke.isPending;

  return (
    <Sheet open={!!target} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{data?.name ?? "Account"}</SheetTitle>
          <SheetDescription>
            {data ? `${data.loginId} · ${data.role}` : "Loading…"}
          </SheetDescription>
        </SheetHeader>

        {isLoading || !data ? (
          <div className="mt-6 space-y-3">
            <Skeleton className="h-20" />
            <Skeleton className="h-40" />
          </div>
        ) : (
          <div className="mt-6 space-y-6">
            <StatusBadges
              row={{
                isActive: data.isActive,
                locked: data.locked,
                twoFactor: data.has2fa,
              }}
            />

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Account ID</dt>
              <dd className="font-mono text-xs">{data.accountId}</dd>
              <dt className="text-muted-foreground">Second factors</dt>
              <dd>
                {[
                  data.methods.passkeys > 0 &&
                    `${data.methods.passkeys} passkey(s)`,
                  data.methods.totp && "Authenticator app",
                  data.methods.sms && `SMS ${data.phone ?? ""}`,
                  data.methods.email && `Email ${data.contactEmail ?? ""}`,
                ]
                  .filter(Boolean)
                  .join(", ") || "None"}
              </dd>
              <dt className="text-muted-foreground">Backup codes left</dt>
              <dd>{data.methods.backupCodes}</dd>
              {data.mustChangePassword && (
                <>
                  <dt className="text-muted-foreground">Password</dt>
                  <dd className="text-amber-600 dark:text-amber-400">
                    Must change at next sign-in
                  </dd>
                </>
              )}
              {data.locked && (
                <>
                  <dt className="text-muted-foreground">Locked until</dt>
                  <dd>{formatWhen(data.lockedUntil)}</dd>
                </>
              )}
              {!data.isActive && data.suspendedReason && (
                <>
                  <dt className="text-muted-foreground">Suspension reason</dt>
                  <dd>{data.suspendedReason}</dd>
                </>
              )}
            </dl>

            {data.type === "USER" &&
              EMPLOYEE_ROLES.includes(
                data.role as (typeof EMPLOYEE_ROLES)[number],
              ) && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Role</Label>
                  <Select
                    value={data.role}
                    disabled={setRole.isPending}
                    onValueChange={(role) =>
                      setRole.mutate({
                        id: data.id,
                        role: role as (typeof EMPLOYEE_ROLES)[number],
                      })
                    }
                  >
                    <SelectTrigger className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {EMPLOYEE_ROLES.filter(
                        (r) =>
                          r !== "ADMIN" ||
                          canGrantAdmin ||
                          data.role === "ADMIN",
                      ).map((r) => (
                        <SelectItem key={r} value={r}>
                          {r}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Changing the role signs the user out so the new access
                    applies straight away.
                  </p>
                </div>
              )}

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {data.isActive ? (
                <Button
                  variant="outline"
                  className="justify-start text-rose-600"
                  onClick={() => setConfirm("suspend")}
                >
                  <Ban className="mr-2 h-4 w-4" /> Suspend account
                </Button>
              ) : (
                <Button
                  variant="outline"
                  className="justify-start"
                  disabled={setActive.isPending}
                  onClick={() => setActive.mutate({ ...target!, active: true })}
                >
                  <UserCheck className="mr-2 h-4 w-4" /> Reactivate account
                </Button>
              )}
              <Button
                variant="outline"
                className="justify-start"
                disabled={!data.locked || unlock.isPending}
                onClick={() => unlock.mutate(target!)}
              >
                <LockOpen className="mr-2 h-4 w-4" /> Unlock sign-in
              </Button>
              <Button
                variant="outline"
                className="justify-start"
                onClick={() => setConfirm("resetPassword")}
              >
                <KeyRound className="mr-2 h-4 w-4" /> Reset password
              </Button>
              <Button
                variant="outline"
                className="justify-start"
                disabled={!data.has2fa && data.methods.backupCodes === 0}
                onClick={() => setConfirm("reset2fa")}
              >
                <ShieldOff className="mr-2 h-4 w-4" /> Reset 2FA
              </Button>
              <Button
                variant="outline"
                className="justify-start sm:col-span-2"
                disabled={data.sessions.length === 0}
                onClick={() => setConfirm("revoke")}
              >
                <LogOut className="mr-2 h-4 w-4" /> Sign out of all devices (
                {data.sessions.length})
              </Button>
            </div>

            <div className="space-y-2">
              <h3 className="text-sm font-semibold">Signed-in devices</h3>
              {data.sessions.length === 0 ? (
                <p className="text-xs text-muted-foreground">None.</p>
              ) : (
                <ul className="space-y-1.5 text-xs">
                  {data.sessions.map((s) => (
                    <li
                      key={s.id}
                      className="rounded-md border border-border px-2.5 py-1.5"
                    >
                      <span className="font-medium">
                        {describeDevice(s.userAgent)}
                      </span>
                      <span className="text-muted-foreground">
                        {" "}
                        · active {formatWhen(s.lastSeenAt)}
                        {s.ip && ` · ${s.ip}`}
                        {s.mfaPending && " · waiting for 2FA"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="space-y-2">
              <h3 className="text-sm font-semibold">Security activity</h3>
              {data.events.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No activity recorded.
                </p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {data.events.map((e) => (
                    <li
                      key={e.id}
                      className="flex flex-wrap justify-between gap-x-2"
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
                      <span className="text-muted-foreground">
                        {formatWhen(e.createdAt)}
                        {e.ip && ` · ${e.ip}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>
                {confirm === "suspend" && "Suspend this account?"}
                {confirm === "reset2fa" && "Reset two-factor authentication?"}
                {confirm === "resetPassword" && "Reset this password?"}
                {confirm === "revoke" && "Sign out of all devices?"}
              </DialogTitle>
              <DialogDescription>
                {confirm === "suspend" &&
                  "They'll be signed out everywhere and can't sign in until reactivated."}
                {confirm === "reset2fa" &&
                  "All their passkeys, authenticator app, SMS/email codes and backup codes are removed, and they're signed out. Only do this after confirming their identity in person or by phone."}
                {confirm === "resetPassword" &&
                  "A temporary password is created and shown once. They must choose a new password when they next sign in. All their devices are signed out."}
                {confirm === "revoke" &&
                  "Every device is signed out and remembered devices are forgotten."}
              </DialogDescription>
            </DialogHeader>
            {confirm === "suspend" && (
              <div className="space-y-1.5">
                <Label htmlFor="suspend-reason" className="text-xs">
                  Reason (recorded in the audit log)
                </Label>
                <Textarea
                  id="suspend-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={300}
                  rows={2}
                />
              </div>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  if (!target) return;
                  if (confirm === "suspend")
                    setActive.mutate({
                      ...target,
                      active: false,
                      reason: reason || undefined,
                    });
                  if (confirm === "reset2fa") reset2fa.mutate(target);
                  if (confirm === "resetPassword") resetPassword.mutate(target);
                  if (confirm === "revoke") revoke.mutate(target);
                }}
              >
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Confirm
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog
          open={!!tempPassword}
          onOpenChange={(o) => !o && setTempPassword(null)}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Temporary password</DialogTitle>
              <DialogDescription>
                Give this to the user privately. It isn&apos;t stored anywhere
                and won&apos;t be shown again.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-4 py-3">
              <code className="font-mono text-lg tracking-wider">
                {tempPassword}
              </code>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Copy temporary password"
                onClick={() => {
                  if (tempPassword)
                    void navigator.clipboard.writeText(tempPassword);
                  toast({ title: "Copied" });
                }}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={() => setTempPassword(null)}>Done</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </SheetContent>
    </Sheet>
  );
}

// ─── Accounts list ─────────────────────────────────────────────────────

function AccountsList({ canGrantAdmin }: { canGrantAdmin: boolean }) {
  const [kind, setKind] = useState<"users" | "parents">("users");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [role, setRole] = useState<string>("all");
  const [status, setStatus] = useState<
    "all" | "active" | "suspended" | "locked"
  >("all");
  const [twoFactor, setTwoFactor] = useState<"all" | "on" | "off">("all");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Target | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => setPage(1), [kind, debounced, role, status, twoFactor]);

  const pageSize = 25;
  const { data, isLoading, isFetching } = api.accounts.list.useQuery({
    kind,
    search: debounced || undefined,
    role:
      kind === "users" && role !== "all"
        ? (role as (typeof ROLES)[number])
        : undefined,
    status,
    twoFactor,
    page,
    pageSize,
  });
  const pages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;

  return (
    <Card className="border-border bg-card shadow-sm">
      <CardHeader className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">Accounts</CardTitle>
            <CardDescription className="text-xs">
              {data ? `${data.total} account(s)` : "Loading…"}
              {isFetching && !isLoading && " · updating"}
            </CardDescription>
          </div>
          <Tabs value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
            <TabsList>
              <TabsTrigger value="users">Staff &amp; students</TabsTrigger>
              <TabsTrigger value="parents">Parents</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <div className="flex flex-col gap-2 lg:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={
                kind === "users"
                  ? "Search name, email or ID"
                  : "Search username or mobile"
              }
              className="pl-8"
              aria-label="Search accounts"
            />
          </div>
          {kind === "users" && (
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger className="lg:w-40" aria-label="Filter by role">
                <SelectValue placeholder="Role" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All roles</SelectItem>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select
            value={status}
            onValueChange={(v) => setStatus(v as typeof status)}
          >
            <SelectTrigger className="lg:w-40" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any status</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="suspended">Suspended</SelectItem>
              <SelectItem value="locked">Locked out</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={twoFactor}
            onValueChange={(v) => setTwoFactor(v as typeof twoFactor)}
          >
            <SelectTrigger className="lg:w-36" aria-label="Filter by 2FA">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any 2FA</SelectItem>
              <SelectItem value="on">2FA on</SelectItem>
              <SelectItem value="off">2FA off</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="px-0 sm:px-6">
        {isLoading ? (
          <div className="space-y-2 px-4 sm:px-0">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden md:table-cell">
                    Sign-in ID
                  </TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden lg:table-cell">
                    Last sign-in
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.rows.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="py-8 text-center text-sm text-muted-foreground"
                    >
                      No accounts match these filters.
                    </TableCell>
                  </TableRow>
                )}
                {data?.rows.map((row) => (
                  <TableRow
                    key={row.id}
                    className="cursor-pointer"
                    tabIndex={0}
                    onClick={() => setSelected({ id: row.id, type: row.type })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelected({ id: row.id, type: row.type });
                      }
                    }}
                  >
                    <TableCell className="font-medium">
                      {row.name}
                      <span className="block text-xs font-normal text-muted-foreground md:hidden">
                        {row.loginId}
                      </span>
                    </TableCell>
                    <TableCell className="hidden font-mono text-xs md:table-cell">
                      {row.loginId}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="text-[10px]">
                        {row.role}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <StatusBadges row={row} />
                    </TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
                      {row.lastSignInAt
                        ? formatWhen(row.lastSignInAt)
                        : "Never"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <div className="mt-4 flex items-center justify-between px-4 text-xs text-muted-foreground sm:px-0">
          <span>
            Page {page} of {pages}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= pages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      </CardContent>
      <AccountSheet
        target={selected}
        onClose={() => setSelected(null)}
        canGrantAdmin={canGrantAdmin}
      />
    </Card>
  );
}

// ─── Security policy ───────────────────────────────────────────────────

function PolicyPanel() {
  const utils = api.useUtils();
  const { data, isLoading } = api.accounts.policies.useQuery();
  const setPolicy = api.accounts.setPolicy.useMutation({
    onSuccess: (_r, v) => {
      toast({
        title: v.require2fa
          ? `2FA now required for ${v.role}`
          : `2FA now optional for ${v.role}`,
        description: v.require2fa
          ? "Members without 2FA will be asked to set it up at their next sign-in or within 5 minutes."
          : undefined,
      });
      void utils.accounts.policies.invalidate();
    },
    onError,
  });

  return (
    <Card className="border-border bg-card shadow-sm">
      <CardHeader>
        <CardTitle className="text-base">Two-factor policy by role</CardTitle>
        <CardDescription className="text-xs">
          When required, members of a role without 2FA must set it up before
          using the portal. Make sure SMS is configured or members have
          smartphones before requiring it for students or parents.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-64" />
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {data.map((p) => {
              const pct = p.total ? Math.round((p.with2fa / p.total) * 100) : 0;
              return (
                <li
                  key={p.role}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{p.role}</p>
                    <div className="mt-1 flex items-center gap-2">
                      <div
                        className="h-1.5 w-32 overflow-hidden rounded-full bg-muted"
                        aria-hidden
                      >
                        <div
                          className="h-full bg-emerald-500"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {p.with2fa} of {p.total} active accounts have 2FA ({pct}
                        %)
                      </span>
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <span className="text-xs text-muted-foreground">
                      Require 2FA
                    </span>
                    <Switch
                      checked={p.require2fa}
                      disabled={setPolicy.isPending}
                      onCheckedChange={(v) =>
                        setPolicy.mutate({ role: p.role, require2fa: v })
                      }
                      aria-label={`Require 2FA for ${p.role}`}
                    />
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Audit log ─────────────────────────────────────────────────────────

const ACTION_LABELS: Record<string, string> = {
  role_changed: "Changed role",
  suspended: "Suspended",
  reactivated: "Reactivated",
  unlocked: "Unlocked sign-in",
  password_reset: "Reset password",
  two_factor_reset: "Reset 2FA",
  sessions_revoked: "Signed out all devices",
  policy_require_2fa: "Required 2FA for role",
  policy_optional_2fa: "Made 2FA optional for role",
};

function AuditPanel() {
  const [page, setPage] = useState(1);
  const { data, isLoading } = api.accounts.auditLog.useQuery({
    page,
    pageSize: 30,
  });
  const pages = data ? Math.max(1, Math.ceil(data.total / 30)) : 1;
  return (
    <Card className="border-border bg-card shadow-sm">
      <CardHeader>
        <CardTitle className="text-base">Audit log</CardTitle>
        <CardDescription className="text-xs">
          Every action taken from this page, with who did it and from where.
          Entries can&apos;t be edited.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0 sm:px-6">
        {isLoading || !data ? (
          <Skeleton className="mx-4 h-64 sm:mx-0" />
        ) : data.rows.length === 0 ? (
          <p className="px-4 text-sm text-muted-foreground sm:px-0">
            No actions yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Administrator</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead className="hidden md:table-cell">
                    Details
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap text-xs">
                      {formatWhen(r.createdAt)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.actorName ?? r.actorId}
                      <span className="block text-muted-foreground">
                        {r.actorRole}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs font-medium">
                      {ACTION_LABELS[r.action] ?? r.action}
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.targetName ?? r.targetId ?? "—"}
                    </TableCell>
                    <TableCell className="hidden max-w-[16rem] truncate text-xs text-muted-foreground md:table-cell">
                      {r.detail ? JSON.stringify(r.detail) : ""}
                      {r.ip && ` · ${r.ip}`}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <div className="mt-4 flex items-center justify-between px-4 text-xs text-muted-foreground sm:px-0">
          <span>
            Page {page} of {pages}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= pages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Page body ─────────────────────────────────────────────────────────

export default function AccountsAdmin() {
  const { data: session, status } = useSession();
  const role = session?.user.accountType?.toUpperCase() ?? "";

  if (status === "loading") return <Skeleton className="h-96 rounded-2xl" />;
  if (!["ADMIN", "PRINCIPAL"].includes(role)) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 p-6 text-sm text-muted-foreground">
          <ShieldOff className="h-5 w-5" />
          Account administration is limited to the Admin and the Principal.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
          <Users className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Accounts &amp; access
          </h1>
          <p className="text-sm text-muted-foreground">
            Suspend or reactivate accounts, unlock sign-ins, reset passwords and
            2FA, sign people out and set 2FA rules per role.
          </p>
        </div>
      </div>
      <Tabs defaultValue="accounts" className="space-y-4">
        <TabsList>
          <TabsTrigger value="accounts">Accounts</TabsTrigger>
          <TabsTrigger value="policy">Security policy</TabsTrigger>
          <TabsTrigger value="audit">Audit log</TabsTrigger>
        </TabsList>
        <TabsContent value="accounts">
          <AccountsList canGrantAdmin={role === "ADMIN"} />
        </TabsContent>
        <TabsContent value="policy">
          <PolicyPanel />
        </TabsContent>
        <TabsContent value="audit">
          <AuditPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
