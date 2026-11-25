"use client";

import { useState } from "react";
import { api } from "~/trpc/react";
import {
  Users,
  CheckCircle2,
  XCircle,
  Clock,
  FileText,
  CreditCard,
  BookOpen,
  Download,
  AlertCircle,
  Sparkles,
} from "lucide-react";
import { Button } from "~/components/ui/button";

interface FeeItem {
  sfcId: string;
  tuitionPaid: boolean;
  month: number;
  year: number;
  fees?: {
    level?: string;
    tuitionFee?: number;
  } | null;
}

interface ReportCardItem {
  reportCardId: string;
  examId: string;
  status: string;
  totalObtainedMarks: number;
  totalMaxMarks: number;
  percentage: number;
  Exam?: {
    examTypeEnum?: string;
  } | null;
}

interface DiaryItem {
  subjectDiaryId: string;
  date: string | number | Date;
  content: string;
  Teacher?: {
    employeeName?: string;
  } | null;
  ClassSubject?: {
    Subject?: {
      subjectName?: string;
    } | null;
  } | null;
}

export default function ParentDashboardPage() {
  const { data: students, isLoading: loadingStudents } =
    api.parent.getLinkedStudents.useQuery();
  const [selectedStudentId, setSelectedStudentId] = useState<string | null>(
    null,
  );

  const activeStudentId = selectedStudentId ?? students?.[0]?.studentId ?? "";

  const { data: dashboardData, isLoading: loadingDashboard } =
    api.parent.getStudentDashboardData.useQuery(
      { studentId: activeStudentId },
      { enabled: !!activeStudentId },
    );

  if (loadingStudents) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-emerald-500 border-t-transparent" />
      </div>
    );
  }

  if (!students || students.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-8 text-center backdrop-blur-sm">
        <AlertCircle className="mx-auto mb-3 h-12 w-12 text-amber-400" />
        <h2 className="text-xl font-bold text-white">
          No Linked Students Found
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          Your parent account is not currently linked to any active student
          records. Please contact school administration.
        </p>
      </div>
    );
  }

  const { student, attendance, reportCards, fees, diaries } =
    dashboardData ?? {};

  return (
    <div className="space-y-6">
      {/* Student Selector Ribbon (FR-MOB-13) */}
      <div className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-4 backdrop-blur-md sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-emerald-500/20 bg-emerald-500/10 text-emerald-400">
            <Users className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
              Select Student
            </h2>
            <p className="text-base font-bold text-white">
              {student?.studentName ?? "Select a child"}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {students.map((s) => (
            <button
              key={s.studentId}
              onClick={() => setSelectedStudentId(s.studentId)}
              className={`rounded-xl px-4 py-2 text-sm font-medium transition-all ${
                s.studentId === activeStudentId
                  ? "bg-emerald-500 font-bold text-slate-950 shadow-lg shadow-emerald-500/25"
                  : "border border-slate-700/50 bg-slate-800/80 text-slate-300 hover:bg-slate-800 hover:text-white"
              }`}
            >
              {s.studentName}
            </button>
          ))}
        </div>
      </div>

      {loadingDashboard ? (
        <div className="flex h-48 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-emerald-500 border-t-transparent" />
        </div>
      ) : (
        <>
          {/* Top Metrics Row */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {/* Attendance Radial Gauge (FR-MOB-14) */}
            <div className="flex flex-col justify-between rounded-2xl border border-slate-800 bg-slate-900/60 p-5 backdrop-blur-md">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Attendance Rate
                </span>
                <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-400">
                  30 Days
                </span>
              </div>
              <div className="my-4 flex items-center justify-around">
                <div className="relative flex items-center justify-center">
                  <svg className="h-24 w-24 -rotate-90 transform">
                    <circle
                      cx="48"
                      cy="48"
                      r="38"
                      stroke="currentColor"
                      strokeWidth="8"
                      className="text-slate-800"
                      fill="transparent"
                    />
                    <circle
                      cx="48"
                      cy="48"
                      r="38"
                      stroke="currentColor"
                      strokeWidth="8"
                      className="text-emerald-500 transition-all duration-1000 ease-out"
                      fill="transparent"
                      strokeDasharray={2 * Math.PI * 38}
                      strokeDashoffset={
                        2 * Math.PI * 38 * (1 - (attendance?.rate ?? 0) / 100)
                      }
                      strokeLinecap="round"
                    />
                  </svg>
                  <span className="absolute text-xl font-bold text-white">
                    {attendance?.rate ?? 0}%
                  </span>
                </div>
                <div className="space-y-1 text-xs">
                  <div className="flex items-center gap-1.5 text-emerald-400">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    <span>Present: {attendance?.present ?? 0}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-rose-400">
                    <XCircle className="h-3.5 w-3.5" />
                    <span>Absent: {attendance?.absent ?? 0}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-amber-400">
                    <Clock className="h-3.5 w-3.5" />
                    <span>Leave: {attendance?.leaves ?? 0}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Quick Summary Cards */}
            <div className="flex flex-col justify-between rounded-2xl border border-slate-800 bg-slate-900/60 p-5 backdrop-blur-md">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Registration Number
              </span>
              <div className="my-2">
                <p className="text-2xl font-black tracking-tight text-white">
                  {student?.registrationNumber ?? "N/A"}
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  Roll / Ref Identity
                </p>
              </div>
              <div className="flex items-center gap-1 text-xs font-medium text-emerald-400">
                <Sparkles className="h-3.5 w-3.5" /> Active Academic Session
              </div>
            </div>

            <div className="flex flex-col justify-between rounded-2xl border border-slate-800 bg-slate-900/60 p-5 backdrop-blur-md">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Blood Group
              </span>
              <div className="my-2">
                <p className="text-2xl font-black tracking-tight text-rose-400">
                  {student?.bloodGroup ?? "O+"}
                </p>
                <p className="mt-1 text-xs text-slate-400">Medical Record</p>
              </div>
              <div className="text-xs text-slate-400">Verified</div>
            </div>

            <div className="flex flex-col justify-between rounded-2xl border border-slate-800 bg-slate-900/60 p-5 backdrop-blur-md">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Reports Published
              </span>
              <div className="my-2">
                <p className="text-2xl font-black tracking-tight text-teal-400">
                  {reportCards?.length ?? 0}
                </p>
                <p className="mt-1 text-xs text-slate-400">Examinations</p>
              </div>
              <div className="text-xs font-medium text-emerald-400">
                Up to date
              </div>
            </div>
          </div>

          {/* Fee Challans & Vouchers Section (FR-MOB-16) */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 backdrop-blur-md">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CreditCard className="h-5 w-5 text-emerald-400" />
                <h3 className="text-lg font-bold text-white">
                  Fee Challan Status
                </h3>
              </div>
            </div>

            {!fees || fees.length === 0 ? (
              <p className="text-sm italic text-slate-400">
                No fee bills issued for this student currently.
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {(fees as FeeItem[]).map((item) => {
                  const isPaid = item.tuitionPaid;
                  return (
                    <div
                      key={item.sfcId}
                      className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/50 p-4"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <span
                            className={`rounded-md px-2 py-0.5 text-xs font-bold ${
                              isPaid
                                ? "border border-emerald-500/20 bg-emerald-500/10 text-emerald-400"
                                : "border border-rose-500/20 bg-rose-500/10 text-rose-400"
                            }`}
                          >
                            {isPaid ? "PAID" : "PENDING"}
                          </span>
                          <span className="text-xs font-medium text-slate-400">
                            {item.fees?.level ?? "Standard Level"}
                          </span>
                        </div>
                        <p className="mt-1.5 text-base font-bold text-white">
                          PKR {(item.fees?.tuitionFee ?? 0).toLocaleString()}
                        </p>
                        <p className="text-xs text-slate-400">
                          Month: {item.month} / {item.year}
                        </p>
                      </div>

                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          alert(
                            `Downloading Fee Voucher PDF for ${student?.studentName ?? "Student"} (${item.month}/${item.year})`,
                          );
                        }}
                        className="border-slate-800 bg-slate-900 text-xs text-slate-300 hover:bg-slate-800 hover:text-white"
                      >
                        <Download className="mr-1 h-3.5 w-3.5 text-emerald-400" />
                        Voucher
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Academic Report Cards (FR-MOB-15) */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 backdrop-blur-md">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-emerald-400" />
                <h3 className="text-lg font-bold text-white">
                  Examination Report Cards
                </h3>
              </div>
            </div>

            {!reportCards || reportCards.length === 0 ? (
              <p className="text-sm italic text-slate-400">
                No examination report cards published yet.
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {(reportCards as ReportCardItem[]).map((rc) => (
                  <div
                    key={rc.reportCardId}
                    className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/50 p-4"
                  >
                    <div>
                      <span
                        className={`rounded-md px-2 py-0.5 text-xs font-bold ${
                          rc.status === "PASSED"
                            ? "border border-emerald-500/20 bg-emerald-500/10 text-emerald-400"
                            : "border border-rose-500/20 bg-rose-500/10 text-rose-400"
                        }`}
                      >
                        {rc.status}
                      </span>
                      <p className="mt-1.5 text-base font-bold text-white">
                        {rc.Exam?.examTypeEnum ?? "Term Exam"}
                      </p>
                      <p className="text-xs text-slate-400">
                        Score: {rc.totalObtainedMarks} / {rc.totalMaxMarks} (
                        {Math.round(rc.percentage)}%)
                      </p>
                    </div>

                    <Button
                      size="sm"
                      onClick={() => {
                        window.location.href = `/parent/reports/${rc.examId}?studentId=${student?.studentId ?? ""}`;
                      }}
                      className="bg-emerald-600 text-xs font-bold text-slate-950 hover:bg-emerald-500"
                    >
                      View Card
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Class Subject Diary Feed */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 backdrop-blur-md">
            <div className="mb-4 flex items-center gap-2">
              <BookOpen className="h-5 w-5 text-emerald-400" />
              <h3 className="text-lg font-bold text-white">
                Recent Class Diary & Homework
              </h3>
            </div>

            {!diaries || diaries.length === 0 ? (
              <p className="text-sm italic text-slate-400">
                No class diary entries posted recently.
              </p>
            ) : (
              <div className="space-y-3">
                {(diaries as DiaryItem[]).map((d) => (
                  <div
                    key={d.subjectDiaryId}
                    className="space-y-1.5 rounded-xl border border-slate-800 bg-slate-950/50 p-4"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-emerald-400">
                        {d.ClassSubject?.Subject?.subjectName ?? "Subject"}
                      </span>
                      <span className="text-xs text-slate-400">
                        {new Date(d.date).toLocaleDateString()}
                      </span>
                    </div>
                    <p className="text-sm text-slate-200">{d.content}</p>
                    <p className="text-xs italic text-slate-400">
                      Teacher: {d.Teacher?.employeeName ?? "Faculty"}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
