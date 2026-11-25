import { PageHeader } from "~/components/blocks/nav/PageHeader";
import {
  ClassTimetableTab,
  ClassAttendanceTab,
  ClassExamsTab,
  ClassDiariesTab,
  ClassSubjectsTab,
} from "~/components/blocks/class/lazy-tabs";
import { ClassAllotmentTable } from "~/components/tables/ClassAlotment";
import { ClassStatsHeader } from "~/components/blocks/class/ClassStatsHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import {
  Users,
  BookOpen,
  Clock,
  FileText,
  ClipboardCheck,
  Library,
} from "lucide-react";

type PageProps = {
  searchParams: Promise<{ classId: string; sessionId: string; tab?: string }>;
};

export default async function ClassDetailsPage({ searchParams }: PageProps) {
  const searchProps = await searchParams;

  const breadcrumbs = [
    { href: "/admin", label: "Dashboard" },
    {
      href: `/admin/sessions`,
      label: "Sessions",
    },
    {
      href: `/admin/sessions/${searchProps.sessionId}`,
      label: "Session Details",
    },
  ];

  return (
    // Wrapper: Full width, standard spacing
    <div className="w-full space-y-6">
      {/* PageHeader in layout */}

      <ClassStatsHeader
        classId={searchProps.classId}
        sessionId={searchProps.sessionId}
      />

      {/* Render Table Directly without redundant Card wrapper */}
      <div className="mt-6 duration-500 animate-in fade-in">
        <Tabs defaultValue={searchProps.tab ?? "roster"} className="w-full">
          <TabsList className="mb-8 grid w-full grid-cols-3 border border-slate-200 bg-card p-1 dark:border-border md:grid-cols-6">
            <TabsTrigger
              value="roster"
              className="data-[state=active]:bg-emerald-600/20 data-[state=active]:text-emerald-700 dark:data-[state=active]:text-emerald-400"
            >
              <Users className="mr-2 h-4 w-4" /> Roster
            </TabsTrigger>
            <TabsTrigger
              value="subjects"
              className="data-[state=active]:bg-teal-600/20 data-[state=active]:text-teal-700 dark:data-[state=active]:text-teal-400"
            >
              <Library className="mr-2 h-4 w-4" /> Subjects
            </TabsTrigger>
            <TabsTrigger
              value="timetable"
              className="data-[state=active]:bg-blue-600/20 data-[state=active]:text-blue-700 dark:data-[state=active]:text-blue-400"
            >
              <Clock className="mr-2 h-4 w-4" /> Timetable
            </TabsTrigger>
            <TabsTrigger
              value="attendance"
              className="data-[state=active]:bg-purple-600/20 data-[state=active]:text-purple-700 dark:data-[state=active]:text-purple-400"
            >
              <ClipboardCheck className="mr-2 h-4 w-4" /> Attendance
            </TabsTrigger>
            <TabsTrigger
              value="exams"
              className="data-[state=active]:bg-amber-600/20 data-[state=active]:text-amber-700 dark:data-[state=active]:text-amber-400"
            >
              <FileText className="mr-2 h-4 w-4" /> Exams
            </TabsTrigger>
            <TabsTrigger
              value="diaries"
              className="data-[state=active]:bg-indigo-600/20 data-[state=active]:text-indigo-700 dark:data-[state=active]:text-indigo-400"
            >
              <BookOpen className="mr-2 h-4 w-4" /> Diaries
            </TabsTrigger>
          </TabsList>

          <TabsContent value="roster" className="m-0">
            <ClassAllotmentTable
              classId={searchProps.classId}
              sessionId={searchProps.sessionId}
            />
          </TabsContent>

          <TabsContent value="timetable" className="m-0">
            <ClassTimetableTab
              classId={searchProps.classId}
              sessionId={searchProps.sessionId}
            />
          </TabsContent>

          <TabsContent value="attendance" className="m-0">
            <ClassAttendanceTab
              classId={searchProps.classId}
              sessionId={searchProps.sessionId}
            />
          </TabsContent>

          <TabsContent value="exams" className="m-0">
            <ClassExamsTab
              classId={searchProps.classId}
              sessionId={searchProps.sessionId}
            />
          </TabsContent>

          <TabsContent value="diaries" className="m-0">
            <ClassDiariesTab
              classId={searchProps.classId}
              sessionId={searchProps.sessionId}
            />
          </TabsContent>

          <TabsContent value="subjects" className="m-0">
            <ClassSubjectsTab
              classId={searchProps.classId}
              sessionId={searchProps.sessionId}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
