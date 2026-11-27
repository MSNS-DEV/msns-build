"use client";

import { useState } from "react";
import { api } from "~/trpc/react";
import { Check, X, Clock, Send, Sparkles, UserCheck } from "lucide-react";
import { Button } from "~/components/ui/button";

interface ClassItem {
  classId: string;
  grade: string;
  section: string;
}

interface SessionItem {
  sessionId: string;
  name: string;
}

interface StudentItem {
  studentId: string;
  studentName: string;
  registrationNumber: string;
}

export default function RapidAttendancePage() {
  const [classId, setClassId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [records, setRecords] = useState<Record<string, "P" | "A" | "L">>({});
  const [submitting, setSubmitting] = useState(false);

  const { data: classes } = api.class.getClasses.useQuery();
  const { data: sessions } = api.session.getSessions.useQuery();

  const activeClassId =
    classId !== ""
      ? classId
      : ((classes as ClassItem[] | undefined)?.[0]?.classId ?? "");
  const activeSessionId =
    sessionId !== ""
      ? sessionId
      : ((sessions as SessionItem[] | undefined)?.[0]?.sessionId ?? "");

  const { data: students, isLoading } =
    api.student.getStudentsByClassAndSession.useQuery(
      { classId: activeClassId, sessionId: activeSessionId },
      { enabled: !!activeClassId && !!activeSessionId },
    );

  const markAttendanceMutation =
    api.attendance.markStudentAttendance.useMutation();

  const handleToggle = (studentId: string) => {
    setRecords((prev) => {
      const current = prev[studentId] ?? "P";
      const next = current === "P" ? "A" : current === "A" ? "L" : "P";
      return { ...prev, [studentId]: next };
    });
  };

  const handleSetAll = (status: "P" | "A" | "L") => {
    if (!students) return;
    const newRecords: Record<string, "P" | "A" | "L"> = {};
    (students as StudentItem[]).forEach((s) => {
      newRecords[s.studentId] = status;
    });
    setRecords(newRecords);
  };

  const handleSubmit = async () => {
    if (!students || students.length === 0) return;
    setSubmitting(true);
    try {
      const formattedRecords = (students as StudentItem[]).map((s) => ({
        studentId: s.studentId,
        status: records[s.studentId] ?? "P",
      }));

      await markAttendanceMutation.mutateAsync({
        classId: activeClassId,
        sessionId: activeSessionId,
        date: new Date().toLocaleDateString("en-CA"),
        records: formattedRecords,
      });

      alert("Rapid attendance recorded successfully!");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "An unknown error occurred";
      alert(`Attendance save failed: ${message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-white">
            <UserCheck className="h-6 w-6 text-emerald-400" /> Rapid Attendance
            Marker
          </h1>
          <p className="text-sm text-slate-400">
            One-tap classroom attendance entry with smart defaults
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => handleSetAll("P")}
            className="border border-emerald-500/20 bg-emerald-500/10 text-xs text-emerald-400 hover:bg-emerald-500/20"
          >
            <Sparkles className="mr-1 h-3.5 w-3.5" /> All Present (P)
          </Button>
          <Button
            size="sm"
            onClick={() => handleSetAll("A")}
            className="border border-rose-500/20 bg-rose-500/10 text-xs text-rose-400 hover:bg-rose-500/20"
          >
            All Absent (A)
          </Button>
        </div>
      </div>

      <div className="grid gap-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:grid-cols-2">
        <div>
          <label className="text-xs font-semibold uppercase text-slate-400">
            Class Level
          </label>
          <select
            value={activeClassId}
            onChange={(e) => setClassId(e.target.value)}
            className="mt-1 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
          >
            {(classes as ClassItem[] | undefined)?.map((c) => (
              <option key={c.classId} value={c.classId}>
                {c.grade} - {c.section}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-xs font-semibold uppercase text-slate-400">
            Academic Session
          </label>
          <select
            value={activeSessionId}
            onChange={(e) => setSessionId(e.target.value)}
            className="mt-1 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
          >
            {(sessions as SessionItem[] | undefined)?.map((s) => (
              <option key={s.sessionId} value={s.sessionId}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {isLoading ? (
        <div className="flex h-48 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-emerald-500 border-t-transparent" />
        </div>
      ) : !students || students.length === 0 ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-8 text-center text-slate-400">
          No students enrolled in the selected class and session.
        </div>
      ) : (
        <div className="space-y-3">
          {(students as StudentItem[]).map((student) => {
            const status = records[student.studentId] ?? "P";
            return (
              <div
                key={student.studentId}
                onClick={() => handleToggle(student.studentId)}
                className="flex cursor-pointer select-none items-center justify-between rounded-xl border border-slate-800 bg-slate-950/60 p-4 transition-all hover:border-slate-700"
              >
                <div>
                  <p className="text-base font-bold text-white">
                    {student.studentName}
                  </p>
                  <p className="text-xs text-slate-400">
                    Reg: {student.registrationNumber}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <span
                    className={`flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-bold transition-all ${
                      status === "P"
                        ? "bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/20"
                        : status === "A"
                          ? "bg-rose-500 text-white shadow-md shadow-rose-500/20"
                          : "bg-amber-500 text-slate-950 shadow-md shadow-amber-500/20"
                    }`}
                  >
                    {status === "P" && <Check className="h-4 w-4" />}
                    {status === "A" && <X className="h-4 w-4" />}
                    {status === "L" && <Clock className="h-4 w-4" />}
                    {status === "P"
                      ? "PRESENT"
                      : status === "A"
                        ? "ABSENT"
                        : "LEAVE"}
                  </span>
                </div>
              </div>
            );
          })}

          <Button
            onClick={() => void handleSubmit()}
            disabled={submitting}
            className="mt-4 w-full bg-emerald-600 py-6 text-base font-bold text-slate-950 shadow-lg shadow-emerald-600/25 hover:bg-emerald-500"
          >
            <Send className="mr-2 h-5 w-5" /> Submit Attendance Records
          </Button>
        </div>
      )}
    </div>
  );
}
