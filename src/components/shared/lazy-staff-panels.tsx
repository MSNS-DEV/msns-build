"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "~/components/ui/skeleton";

// Salary and attendance panels are heavy (charts, PDF export) and live in
// non-default tabs, so they are loaded the first time their tab is opened.

function PanelLoading() {
  return (
    <div className="space-y-3" aria-busy="true">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-72 w-full" />
    </div>
  );
}

export const LazySalaryContent = dynamic(
  () =>
    import("~/app/(dashboard)/admin/erp/revenue/salary/SalaryContent").then(
      (m) => m.SalaryContent,
    ),
  { loading: PanelLoading },
);

export const LazyEmployeeAttendanceContent = dynamic(
  () =>
    import(
      "~/app/(dashboard)/admin/sessions/attendance/employees/EmployeeAttendanceContent"
    ).then((m) => m.EmployeeAttendanceContent),
  { loading: PanelLoading },
);

export const LazyAttendancePage = dynamic(
  () => import("~/app/(dashboard)/admin/attendance/page"),
  { loading: PanelLoading },
);
