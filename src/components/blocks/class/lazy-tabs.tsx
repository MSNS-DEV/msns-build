"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "~/components/ui/skeleton";

// Class detail tabs are loaded on demand: Radix only renders the active
// TabsContent, so each tab's code is fetched the first time it is opened
// instead of shipping every tab with the page.

function TabLoading() {
  return (
    <div className="space-y-3 p-2" aria-busy="true">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export const ClassTimetableTab = dynamic(
  () => import("./ClassTimetableTab").then((m) => m.ClassTimetableTab),
  { loading: TabLoading },
);

export const ClassAttendanceTab = dynamic(
  () => import("./ClassAttendanceTab").then((m) => m.ClassAttendanceTab),
  { loading: TabLoading },
);

export const ClassExamsTab = dynamic(
  () => import("./ClassExamsTab").then((m) => m.ClassExamsTab),
  { loading: TabLoading },
);

export const ClassDiariesTab = dynamic(
  () => import("./ClassDiariesTab").then((m) => m.ClassDiariesTab),
  { loading: TabLoading },
);

export const ClassSubjectsTab = dynamic(
  () => import("./ClassSubjectsTab").then((m) => m.ClassSubjectsTab),
  { loading: TabLoading },
);
