"use client";

import React, { useState, useMemo } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Shield,
  Users,
  Check,
  X,
  Search,
  UserCheck,
  Sparkles,
  BookOpen,
  DollarSign,
  GraduationCap,
  Settings,
} from "lucide-react";
import { api } from "~/trpc/react";
import { cn } from "~/lib/utils";

interface RoleDef {
  role: string;
  label: string;
  description: string;
  color: string;
  badgeBg: string;
  permissions: {
    userManagement: boolean;
    academics: boolean;
    attendance: boolean;
    examinations: boolean;
    financials: boolean;
    systemSettings: boolean;
  };
}

const SYSTEM_ROLES: RoleDef[] = [
  {
    role: "ADMIN",
    label: "Administrator",
    description:
      "Full institutional control, system settings, database management, and user governance.",
    color: "text-red-600 dark:text-red-400",
    badgeBg:
      "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300",
    permissions: {
      userManagement: true,
      academics: true,
      attendance: true,
      examinations: true,
      financials: true,
      systemSettings: true,
    },
  },
  {
    role: "PRINCIPAL",
    label: "Principal",
    description:
      "Academic leadership, institutional performance monitoring, ERP, and staff oversight.",
    color: "text-purple-600 dark:text-purple-400",
    badgeBg:
      "bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300",
    permissions: {
      userManagement: true,
      academics: true,
      attendance: true,
      examinations: true,
      financials: true,
      systemSettings: true,
    },
  },
  {
    role: "HEAD",
    label: "Headmaster / Headmistress",
    description:
      "Section supervision, academic routines, examinations, ERP & financials, and attendance compliance.",
    color: "text-indigo-600 dark:text-indigo-400",
    badgeBg:
      "bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-300",
    permissions: {
      userManagement: true,
      academics: true,
      attendance: true,
      examinations: true,
      financials: true,
      systemSettings: true,
    },
  },
  {
    role: "CLERK",
    label: "Clerk / Registrar",
    description:
      "Student enrollments, fee challans, examination marking, ERP & financials, and record keeping.",
    color: "text-amber-600 dark:text-amber-400",
    badgeBg:
      "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300",
    permissions: {
      userManagement: true,
      academics: true,
      attendance: true,
      examinations: true,
      financials: true,
      systemSettings: false,
    },
  },
  {
    role: "TEACHER",
    label: "Teacher / Faculty",
    description:
      "Classroom attendance marking, homework diary entries, period timetables, and student grading.",
    color: "text-emerald-600 dark:text-emerald-400",
    badgeBg:
      "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300",
    permissions: {
      userManagement: false,
      academics: true,
      attendance: true,
      examinations: true,
      financials: false,
      systemSettings: false,
    },
  },
  {
    role: "STUDENT",
    label: "Student",
    description:
      "Personal course dashboard, exam results, daily subject diary, and attendance tracking.",
    color: "text-blue-600 dark:text-blue-400",
    badgeBg:
      "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300",
    permissions: {
      userManagement: false,
      academics: false,
      attendance: false,
      examinations: false,
      financials: false,
      systemSettings: false,
    },
  },
  {
    role: "WORKER",
    label: "Staff / Worker",
    description: "Support personnel with biometric attendance registration.",
    color: "text-slate-600 dark:text-slate-400",
    badgeBg:
      "bg-slate-50 text-slate-700 border-slate-200 dark:bg-muted dark:text-foreground",
    permissions: {
      userManagement: false,
      academics: false,
      attendance: false,
      examinations: false,
      financials: false,
      systemSettings: false,
    },
  },
];

export function RoleManagementTab() {
  const { data: users, isLoading } = api.user.getUsers.useQuery();
  const [selectedRole, setSelectedRole] = useState<string>("ADMIN");
  const [searchQuery, setSearchQuery] = useState("");

  const roleCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    users?.forEach((u) => {
      counts[u.accountType] = (counts[u.accountType] ?? 0) + 1;
    });
    return counts;
  }, [users]);

  const activeRoleDef =
    SYSTEM_ROLES.find((r) => r.role === selectedRole) ?? SYSTEM_ROLES[0]!;

  const filteredUsers = useMemo(() => {
    return (users ?? [])
      .filter((u) => u.accountType === selectedRole)
      .filter((u) => {
        if (!searchQuery) return true;
        const q = searchQuery.toLowerCase();
        return (
          u.username.toLowerCase().includes(q) ||
          u.email?.toLowerCase().includes(q) ||
          u.accountId?.toLowerCase().includes(q)
        );
      });
  }, [users, selectedRole, searchQuery]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-foreground">
            Role Governance & Access Control
          </h2>
          <p className="text-xs text-muted-foreground">
            Overview of system permissions, access tiers, and enrolled users per
            role
          </p>
        </div>
      </div>

      {/* Role Selector Grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {SYSTEM_ROLES.map((r) => {
          const count = roleCounts[r.role] ?? 0;
          const isSelected = selectedRole === r.role;

          return (
            <Card
              key={r.role}
              onClick={() => setSelectedRole(r.role)}
              className={cn(
                "cursor-pointer rounded-2xl border p-3.5 transition-all duration-200 hover:shadow-md",
                isSelected
                  ? "border-emerald-600 bg-emerald-50/40 ring-2 ring-emerald-500 dark:bg-emerald-950/20"
                  : "border-slate-200 bg-white hover:border-slate-300 dark:border-border dark:bg-card",
              )}
            >
              <div className="flex items-center justify-between">
                <Badge
                  variant="outline"
                  className={cn(
                    "py-0.2 px-1.5 text-[10px] font-bold",
                    r.badgeBg,
                  )}
                >
                  {r.role}
                </Badge>
                <span className="text-xs font-bold text-slate-900 dark:text-foreground">
                  {isLoading ? "..." : count}
                </span>
              </div>
              <p className="mt-2 truncate text-xs font-semibold text-slate-800 dark:text-foreground">
                {r.label}
              </p>
            </Card>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Role Permissions Matrix */}
        <Card className="rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-border dark:bg-card">
          <CardHeader className="border-b border-slate-100 p-4 dark:border-border/60">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2 text-base font-bold text-slate-900 dark:text-foreground">
                  <Shield className={cn("h-4 w-4", activeRoleDef.color)} />
                  {activeRoleDef.label} Permissions
                </CardTitle>
                <CardDescription className="mt-0.5 text-xs">
                  {activeRoleDef.description}
                </CardDescription>
              </div>
            </div>
          </CardHeader>

          <CardContent className="p-0">
            <div className="divide-y divide-slate-100 text-xs dark:divide-border/40">
              <div className="flex items-center justify-between p-3.5">
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-muted-foreground" />
                  <span>User & Account Management</span>
                </div>
                {activeRoleDef.permissions.userManagement ? (
                  <Badge className="gap-1 bg-emerald-100 text-[10px] text-emerald-800">
                    <Check className="h-3 w-3" /> Granted
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className="gap-1 text-[10px] text-muted-foreground"
                  >
                    <X className="h-3 w-3" /> Restricted
                  </Badge>
                )}
              </div>

              <div className="flex items-center justify-between p-3.5">
                <div className="flex items-center gap-2">
                  <BookOpen className="h-4 w-4 text-muted-foreground" />
                  <span>Academics & Timetables</span>
                </div>
                {activeRoleDef.permissions.academics ? (
                  <Badge className="gap-1 bg-emerald-100 text-[10px] text-emerald-800">
                    <Check className="h-3 w-3" /> Granted
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className="gap-1 text-[10px] text-muted-foreground"
                  >
                    <X className="h-3 w-3" /> Restricted
                  </Badge>
                )}
              </div>

              <div className="flex items-center justify-between p-3.5">
                <div className="flex items-center gap-2">
                  <UserCheck className="h-4 w-4 text-muted-foreground" />
                  <span>Student & Staff Attendance</span>
                </div>
                {activeRoleDef.permissions.attendance ? (
                  <Badge className="gap-1 bg-emerald-100 text-[10px] text-emerald-800">
                    <Check className="h-3 w-3" /> Granted
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className="gap-1 text-[10px] text-muted-foreground"
                  >
                    <X className="h-3 w-3" /> Restricted
                  </Badge>
                )}
              </div>

              <div className="flex items-center justify-between p-3.5">
                <div className="flex items-center gap-2">
                  <GraduationCap className="h-4 w-4 text-muted-foreground" />
                  <span>Exams, Marks & Report Cards</span>
                </div>
                {activeRoleDef.permissions.examinations ? (
                  <Badge className="gap-1 bg-emerald-100 text-[10px] text-emerald-800">
                    <Check className="h-3 w-3" /> Granted
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className="gap-1 text-[10px] text-muted-foreground"
                  >
                    <X className="h-3 w-3" /> Restricted
                  </Badge>
                )}
              </div>

              <div className="flex items-center justify-between p-3.5">
                <div className="flex items-center gap-2">
                  <DollarSign className="h-4 w-4 text-muted-foreground" />
                  <span>Fees, Payments & Finance</span>
                </div>
                {activeRoleDef.permissions.financials ? (
                  <Badge className="gap-1 bg-emerald-100 text-[10px] text-emerald-800">
                    <Check className="h-3 w-3" /> Granted
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className="gap-1 text-[10px] text-muted-foreground"
                  >
                    <X className="h-3 w-3" /> Restricted
                  </Badge>
                )}
              </div>

              <div className="flex items-center justify-between p-3.5">
                <div className="flex items-center gap-2">
                  <Settings className="h-4 w-4 text-muted-foreground" />
                  <span>System Configuration & Logs</span>
                </div>
                {activeRoleDef.permissions.systemSettings ? (
                  <Badge className="gap-1 bg-emerald-100 text-[10px] text-emerald-800">
                    <Check className="h-3 w-3" /> Granted
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className="gap-1 text-[10px] text-muted-foreground"
                  >
                    <X className="h-3 w-3" /> Restricted
                  </Badge>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Users Assigned to this Role */}
        <Card className="rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-border dark:bg-card lg:col-span-2">
          <CardHeader className="border-b border-slate-100 p-4 dark:border-border/60">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle className="text-sm font-bold text-slate-900 dark:text-foreground">
                  Assigned Users ({filteredUsers.length})
                </CardTitle>
                <CardDescription className="text-xs">
                  Accounts with active{" "}
                  <Badge variant="outline" className="ml-1 text-[10px]">
                    {selectedRole}
                  </Badge>{" "}
                  credentials
                </CardDescription>
              </div>

              <div className="relative w-full sm:w-60">
                <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Filter users..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="h-8 rounded-xl pl-8 text-xs"
                />
              </div>
            </div>
          </CardHeader>

          <CardContent className="p-0">
            {isLoading ? (
              <div className="space-y-3 p-6">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : filteredUsers.length > 0 ? (
              <div className="max-h-96 divide-y divide-slate-100 overflow-y-auto dark:divide-border/40">
                {filteredUsers.map((u) => (
                  <div
                    key={u.id}
                    className="flex items-center justify-between p-3.5 transition-colors hover:bg-slate-50/60 dark:hover:bg-muted/20"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-100 text-xs font-bold text-slate-700 dark:bg-muted dark:text-foreground">
                        {u.username.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <p className="text-xs font-bold text-slate-900 dark:text-foreground">
                          {u.username}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          {u.email ?? "No email"} • ID: {u.accountId ?? "N/A"}
                        </p>
                      </div>
                    </div>

                    <Badge
                      variant="outline"
                      className="border-emerald-200 bg-emerald-50 text-[10px] text-emerald-700"
                    >
                      Active
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-12 text-center text-xs text-muted-foreground">
                <Users className="mx-auto mb-2 h-6 w-6 opacity-30" />
                No active users found for {selectedRole} role.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
