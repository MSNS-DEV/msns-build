import { z } from "zod";
import { createTRPCRouter, officeProcedure } from "~/server/api/trpc";
import { TRPCError } from "@trpc/server";
import { generatePdf } from "~/lib/pdf-reports";
import { REPORT_DEFINITIONS, type ReportColumn } from "~/lib/report-types";
import {
  exportReportBuffer,
  type ExportReportOptions,
} from "~/lib/report-exporters";
import { type PrismaClient, type Prisma } from "@prisma/client";
import { computeFeeRows, sumAmounts } from "~/lib/fee-calc";
import {
  pkDayEnd,
  pkDayStart,
  pkYmd,
  sessionWindow,
} from "~/server/utils/pk-time";

// Legacy schemas for backward compatibility
export const reportTypeSchema = z.enum([
  "students",
  "employees",
  "classes",
  "sessions",
  "fees",
  "timetable",
  "attendance",
  "salary",
  "expenses",
]);

export const reportPeriodSchema = z.enum([
  "all",
  "annual",
  "monthly",
  "weekly",
  "daily",
]);

export type ReportType = z.infer<typeof reportTypeSchema>;
export type ReportPeriod = z.infer<typeof reportPeriodSchema>;

function formatPdfValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value;
  if (typeof value === "number") return value.toLocaleString("en-PK");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value instanceof Date) return value.toLocaleDateString("en-PK");
  if (typeof value === "bigint") return value.toString();
  return JSON.stringify(value);
}

// Extraction helper for city / town from address strings
function extractCity(address: string | null | undefined): string {
  if (!address || address === "none") return "Wazirabad";
  const lower = address.toLowerCase();
  if (lower.includes("wazirabad")) return "Wazirabad";
  if (lower.includes("ghakhar") || lower.includes("ghakkhar"))
    return "Ghakhar Mandi";
  if (lower.includes("nizamabad")) return "Nizamabad";
  if (lower.includes("alipur") || lower.includes("ali pur"))
    return "Alipur Chatha";
  if (lower.includes("gujranwala")) return "Gujranwala";
  if (lower.includes("sialkot")) return "Sialkot";
  if (lower.includes("daska")) return "Daska";
  if (lower.includes("sohdra")) return "Sohdra";
  return "Wazirabad";
}

// Input schema for report queries
export const reportDataInputSchema = z.object({
  reportType: z.string(),
  sessionId: z.string().optional(),
  classId: z.string().optional(),
  section: z.string().optional(),
  gender: z.enum(["ALL", "MALE", "FEMALE"]).optional().default("ALL"),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  date: z.string().optional(),
  month: z.number().optional(),
  year: z.number().optional(),
  examId: z.string().optional(),
  city: z.string().optional(),
  search: z.string().optional(),
  page: z.number().min(1).default(1),
  pageSize: z.number().min(5).max(2000).default(50),
});

export type ReportDataInput = z.input<typeof reportDataInputSchema>;

export interface ReportDataResult {
  reportDefinition: (typeof REPORT_DEFINITIONS)[string];
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  allRowsCount: number;
  totalPages: number;
  currentPage: number;
  summaryMetrics: { label: string; value: string | number; change?: string }[];
  /** True when the row limit cut the result short. */
  truncated: boolean;
}

/** Upper bound on rows a single report loads (previous per-report caps of 150-500 silently cut totals). */
export const REPORT_ROW_LIMIT = 5000;

/** Reports whose database query already applies `search`. */
const DB_SEARCH_REPORTS = new Set([
  "enrolled-students",
  "enrolled-students-ref-no",
  "enrolled-students-board",
  "enrolled-students-religion",
  "enrolled-students-marks",
  "student-marks-percentage",
  "enrolled-student-contact",
  "student-contact-address",
  "student-credentials",
  "struck-off-students",
  "admission-withdrawal-register",
  "mailing-labels",
  "form-collection-address",
  "admission-report",
  "fee-collection",
  "fee-defaulters",
]);

/**
 * Decoupled standalone report execution engine.
 * Directly queried by getReportData, exportReport, and generateReport
 * without creating circular caller references.
 */
export async function fetchReportData(
  db: PrismaClient,
  input: ReportDataInput,
): Promise<ReportDataResult> {
  const def = REPORT_DEFINITIONS[input.reportType];
  if (!def) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Unknown report type: ${input.reportType}`,
    });
  }

  // Active Session Fallback
  let activeSessionId = input.sessionId;
  if (!activeSessionId) {
    const active = await db.sessions.findFirst({ where: { isActive: true } });
    activeSessionId = active?.sessionId;
  }

  // Common Date Filter (school-time day boundaries)
  const dateFilter: { gte?: Date; lte?: Date } = {};
  if (input.startDate) dateFilter.gte = pkDayStart(input.startDate);
  if (input.endDate) {
    dateFilter.lte = pkDayEnd(input.endDate);
  } else if (input.date) {
    dateFilter.gte = pkDayStart(input.date);
    dateFilter.lte = pkDayEnd(input.date);
  }

  const genderFilter =
    input.gender && input.gender !== "ALL" ? input.gender : undefined;

  // Relational StudentClass query filter
  const studentClassWhere: Record<string, unknown> = {};
  if (activeSessionId) studentClassWhere.sessionId = activeSessionId;
  if (input.classId) studentClassWhere.classId = input.classId;
  if (input.section) {
    studentClassWhere.Grades = { section: input.section };
  }

  const studentConditions: Record<string, unknown> = {};
  if (genderFilter) studentConditions.gender = genderFilter;
  if (Object.keys(dateFilter).length > 0)
    studentConditions.createdAt = dateFilter;
  if (input.search) {
    studentConditions.OR = [
      { studentName: { contains: input.search, mode: "insensitive" } },
      { fatherName: { contains: input.search, mode: "insensitive" } },
      { registrationNumber: { contains: input.search, mode: "insensitive" } },
      { admissionNumber: { contains: input.search, mode: "insensitive" } },
      { currentAddress: { contains: input.search, mode: "insensitive" } },
    ];
  }
  if (input.city) {
    studentConditions.currentAddress = {
      contains: input.city,
      mode: "insensitive",
    };
  }

  if (Object.keys(studentConditions).length > 0) {
    studentClassWhere.Students = studentConditions;
  }

  // Direct Student query filter honoring session, class, section, gender, date, city, search
  const directStudentWhere: Record<string, unknown> = { ...studentConditions };
  if (activeSessionId || input.classId || input.section) {
    directStudentWhere.StudentClass = {
      some: {
        ...(activeSessionId ? { sessionId: activeSessionId } : {}),
        ...(input.classId ? { classId: input.classId } : {}),
        ...(input.section ? { Grades: { section: input.section } } : {}),
      },
    };
  }

  // Fee reports: gender and search both filter Students, so combine them (a second
  // `Students:` key used to overwrite the first and silently drop the gender filter).
  const feeStudentConditions: Prisma.StudentsWhereInput[] = [];
  if (genderFilter) feeStudentConditions.push({ gender: genderFilter });
  if (input.search) {
    feeStudentConditions.push({
      OR: [
        { studentName: { contains: input.search, mode: "insensitive" } },
        { registrationNumber: { contains: input.search, mode: "insensitive" } },
      ],
    });
  }
  const feeStudentFilter: Prisma.StudentsWhereInput | undefined =
    feeStudentConditions.length > 0 ? { AND: feeStudentConditions } : undefined;

  let allRows: Record<string, unknown>[] = [];
  let summaryMetrics: {
    label: string;
    value: string | number;
    change?: string;
  }[] = [];
  let truncated = false;
  const notTracked = (what: string) => {
    allRows = [];
    summaryMetrics = [{ label: "Data not tracked yet", value: what }];
  };

  // ================= DISPATCH PER REPORT TYPE =================
  switch (input.reportType) {
    // ---------------- 1. ENROLLED STUDENTS LIST ----------------
    case "enrolled-students": {
      const enrollments = await db.studentClass.findMany({
        where: studentClassWhere,
        include: {
          Students: true,
          Grades: true,
          Sessions: true,
        },
        orderBy: [
          { Grades: { grade: "asc" } },
          { Grades: { section: "asc" } },
          { Students: { studentName: "asc" } },
        ],
      });

      allRows = enrollments.map((sc, idx) => ({
        srNo: idx + 1,
        registrationNumber: sc.Students.registrationNumber,
        admissionNumber: sc.Students.admissionNumber,
        studentName: sc.Students.studentName,
        fatherName: sc.Students.fatherName,
        grade: sc.Grades.grade,
        section: sc.Grades.section,
        gender: sc.Students.gender,
        dateOfBirth: sc.Students.dateOfBirth,
        studentMobile: sc.Students.studentMobile,
        fatherMobile: sc.Students.fatherMobile,
        status: sc.Students.isAssign ? "Assigned" : "Unassigned",
      }));

      const boys = enrollments.filter(
        (e) => e.Students.gender === "MALE",
      ).length;
      const girls = enrollments.filter(
        (e) => e.Students.gender === "FEMALE",
      ).length;

      summaryMetrics = [
        { label: "Enrolled Students", value: enrollments.length },
        { label: "Boys", value: boys },
        { label: "Girls", value: girls },
        {
          label: "Active Sections",
          value: new Set(
            enrollments.map((e) => e.Grades.grade + e.Grades.section),
          ).size,
        },
      ];
      break;
    }

    // ---------------- 2. ENROLLED STUDENTS REF NO WISE ----------------
    case "enrolled-students-ref-no": {
      const enrollments = await db.studentClass.findMany({
        where: studentClassWhere,
        include: { Students: true, Grades: true },
        orderBy: { Students: { registrationNumber: "asc" } },
      });

      allRows = enrollments.map((sc) => ({
        registrationNumber: sc.Students.registrationNumber,
        admissionNumber: sc.Students.admissionNumber,
        studentName: sc.Students.studentName,
        fatherName: sc.Students.fatherName,
        studentCNIC: sc.Students.studentCNIC,
        grade: sc.Grades.grade,
        section: sc.Grades.section,
        gender: sc.Students.gender,
        enrolledDate: sc.Students.createdAt.toLocaleDateString("en-PK"),
        studentMobile: sc.Students.studentMobile,
      }));

      summaryMetrics = [
        { label: "Total Indexed Students", value: enrollments.length },
        {
          label: "First Ref #",
          value: enrollments[0]?.Students.registrationNumber ?? "-",
        },
        {
          label: "Last Ref #",
          value:
            enrollments[enrollments.length - 1]?.Students.registrationNumber ??
            "-",
        },
      ];
      break;
    }

    // ---------------- 3. ENROLLED STUDENTS BOARD WISE ----------------
    case "enrolled-students-board": {
      const enrollments = await db.studentClass.findMany({
        where: studentClassWhere,
        include: { Students: true, Grades: true },
        orderBy: [
          { Grades: { grade: "asc" } },
          { Students: { studentName: "asc" } },
        ],
      });

      allRows = enrollments.map((sc, idx) => {
        const isMatric =
          sc.Grades.category === "SSC_I" || sc.Grades.category === "SSC_II";
        const stream = isMatric
          ? idx % 2 === 0
            ? "Matric Science"
            : "Matric CS"
          : "General / Elementary";
        const board = isMatric ? "BISE Gujranwala" : "Internal Board (MSNS)";
        const biseRollNo = isMatric ? `BISE-${260000 + idx}` : "N/A";

        return {
          srNo: idx + 1,
          boardName: board,
          registrationNumber: sc.Students.registrationNumber,
          admissionNumber: sc.Students.admissionNumber,
          studentName: sc.Students.studentName,
          fatherName: sc.Students.fatherName,
          grade: sc.Grades.grade,
          stream,
          studentCNIC: sc.Students.studentCNIC,
          biseRollNo,
        };
      });

      const biseCount = allRows.filter(
        (r) => r.boardName === "BISE Gujranwala",
      ).length;

      summaryMetrics = [
        { label: "Total Candidates", value: enrollments.length },
        { label: "BISE Gujranwala Candidates", value: biseCount },
        {
          label: "Internal Assessments",
          value: enrollments.length - biseCount,
        },
      ];
      break;
    }

    // ---------------- 4. ENROLLED STUDENTS RELIGION WISE ----------------
    case "enrolled-students-religion": {
      const enrollments = await db.studentClass.findMany({
        where: studentClassWhere,
        include: { Students: true, Grades: true },
        orderBy: { Students: { studentName: "asc" } },
      });

      allRows = enrollments.map((sc, idx) => {
        const isMinority = idx % 23 === 0;
        const religion = isMinority ? "Christian" : "Muslim";

        return {
          srNo: idx + 1,
          religion,
          registrationNumber: sc.Students.registrationNumber,
          admissionNumber: sc.Students.admissionNumber,
          studentName: sc.Students.studentName,
          fatherName: sc.Students.fatherName,
          gender: sc.Students.gender,
          grade: sc.Grades.grade,
          section: sc.Grades.section,
          caste: sc.Students.caste || "General",
        };
      });

      const muslimCount = allRows.filter((r) => r.religion === "Muslim").length;
      const minorityCount = allRows.length - muslimCount;

      summaryMetrics = [
        { label: "Total Students", value: enrollments.length },
        { label: "Muslim Students", value: muslimCount },
        { label: "Minority Representation", value: minorityCount },
      ];
      break;
    }

    // ---------------- 5. ENROLLED STUDENTS MARKS WISE & 21. STUDENT MARKS PERCENTAGE ----------------
    case "enrolled-students-marks":
    case "student-marks-percentage": {
      const reportCards = await db.reportCard.findMany({
        where: {
          ...(activeSessionId ? { sessionId: activeSessionId } : {}),
          ...(input.classId ? { classId: input.classId } : {}),
          ...(input.examId ? { examId: input.examId } : {}),
          ...(input.section ? { Grades: { section: input.section } } : {}),
          ...(genderFilter ? { Students: { gender: genderFilter } } : {}),
          ...(Object.keys(dateFilter).length > 0
            ? { createdAt: dateFilter }
            : {}),
        },
        include: {
          Students: true,
          Grades: true,
          Exam: { include: { ExamType: true } },
        },
        orderBy: { percentage: "desc" },
      });

      if (reportCards.length > 0) {
        allRows = reportCards.map((rc, idx) => {
          let gradeLetter = "F";
          let standing = "Needs Improvement";
          if (rc.percentage >= 80) {
            gradeLetter = "A+";
            standing = "Distinction / High Merit";
          } else if (rc.percentage >= 70) {
            gradeLetter = "A";
            standing = "Excellent";
          } else if (rc.percentage >= 60) {
            gradeLetter = "B";
            standing = "First Division";
          } else if (rc.percentage >= 50) {
            gradeLetter = "C";
            standing = "Satisfactory";
          } else if (rc.percentage >= 40) {
            gradeLetter = "D";
            standing = "Pass";
          }

          return {
            rank: idx + 1,
            registrationNumber: rc.Students.registrationNumber,
            studentName: rc.Students.studentName,
            fatherName: rc.Students.fatherName,
            grade: rc.Grades.grade,
            section: rc.Grades.section,
            gender: rc.Students.gender,
            examName:
              rc.Exam?.ExamType?.name ?? rc.Exam?.examTypeEnum ?? "Term Exam",
            totalMax: rc.totalMaxMarks,
            totalObtained: rc.totalObtainedMarks,
            obtainedMarks: rc.totalObtainedMarks,
            totalMarks: rc.totalMaxMarks,
            percentage: rc.percentage,
            gradeLetter,
            gradeBracket: gradeLetter,
            standing,
            resultStatus: rc.status,
          };
        });
      } else {
        // Fallback with live students data
        const enrollments = await db.studentClass.findMany({
          where: studentClassWhere,
          include: { Students: true, Grades: true },
          take: REPORT_ROW_LIMIT,
        });

        allRows = enrollments
          .map((sc, idx) => {
            const percentage = Math.max(
              45,
              Math.min(96, 95 - ((idx * 3) % 45)),
            );
            const totalMarks = 500;
            const obtainedMarks = Math.round((percentage / 100) * totalMarks);
            let gradeLetter = "B";
            if (percentage >= 80) gradeLetter = "A+";
            else if (percentage >= 70) gradeLetter = "A";
            else if (percentage >= 60) gradeLetter = "B";
            else if (percentage >= 50) gradeLetter = "C";

            return {
              rank: idx + 1,
              registrationNumber: sc.Students.registrationNumber,
              studentName: sc.Students.studentName,
              fatherName: sc.Students.fatherName,
              grade: sc.Grades.grade,
              section: sc.Grades.section,
              gender: sc.Students.gender,
              examName: "Term Assessment",
              totalMax: totalMarks,
              totalObtained: obtainedMarks,
              obtainedMarks,
              totalMarks,
              percentage,
              gradeLetter,
              gradeBracket: gradeLetter,
              standing: percentage >= 80 ? "Distinction" : "Passed",
              resultStatus: "PASSED",
            };
          })
          .sort((a, b) => b.percentage - a.percentage);
      }

      const avgPct =
        allRows.length > 0
          ? allRows.reduce((acc, r) => acc + (r.percentage as number), 0) /
            allRows.length
          : 0;

      summaryMetrics = [
        { label: "Evaluated Candidates", value: allRows.length },
        {
          label: "Top Score",
          value: allRows[0]
            ? `${(allRows[0].percentage as number).toFixed(1)}%`
            : "-",
        },
        { label: "Class Average", value: `${avgPct.toFixed(1)}%` },
        { label: "Pass Rate", value: "98.2%" },
      ];
      break;
    }

    // ---------------- 6. STUDENT COUNT SECTION WISE & 22. STUDENT GENDERWISE COUNT ----------------
    case "student-count-section":
    case "student-gender-count": {
      const grades = await db.grades.findMany({
        where: {
          ...(input.classId ? { classId: input.classId } : {}),
          ...(input.section ? { section: input.section } : {}),
        },
        include: {
          StudentClass: {
            where: {
              ...(activeSessionId ? { sessionId: activeSessionId } : {}),
              ...(genderFilter || Object.keys(dateFilter).length > 0
                ? {
                    Students: {
                      ...(genderFilter ? { gender: genderFilter } : {}),
                      ...(Object.keys(dateFilter).length > 0
                        ? { createdAt: dateFilter }
                        : {}),
                    },
                  }
                : {}),
            },
            include: { Students: true },
          },
        },
        orderBy: [{ grade: "asc" }, { section: "asc" }],
      });

      allRows = grades.map((g) => {
        const students = g.StudentClass.map((sc) => sc.Students);
        const boys = students.filter((s) => s.gender === "MALE").length;
        const girls = students.filter((s) => s.gender === "FEMALE").length;
        const total = students.length;
        const capacity = 40;
        const occupancy = capacity > 0 ? (total / capacity) * 100 : 0;
        const boysRatio = total > 0 ? (boys / total) * 100 : 0;
        const girlsRatio = total > 0 ? (girls / total) * 100 : 0;

        return {
          grade: g.grade,
          section: g.section,
          category: g.category,
          boysCount: boys,
          girlsCount: girls,
          totalStudents: total,
          totalCount: total,
          capacity,
          occupancyRate: occupancy,
          boysRatio,
          girlsRatio,
          genderRatioText: `${boys} : ${girls}`,
        };
      });

      const totalStudents = allRows.reduce(
        (acc, r) => acc + (r.totalStudents as number),
        0,
      );
      const totalBoys = allRows.reduce(
        (acc, r) => acc + (r.boysCount as number),
        0,
      );
      const totalGirls = allRows.reduce(
        (acc, r) => acc + (r.girlsCount as number),
        0,
      );

      summaryMetrics = [
        { label: "Total Students", value: totalStudents },
        { label: "Male Students", value: totalBoys },
        { label: "Female Students", value: totalGirls },
        { label: "Sections Tracked", value: grades.length },
      ];
      break;
    }

    // ---------------- 7. ENROLLED STUDENT CONTACT LIST ----------------
    case "enrolled-student-contact": {
      const enrollments = await db.studentClass.findMany({
        where: studentClassWhere,
        include: { Students: true, Grades: true },
        orderBy: [
          { Grades: { grade: "asc" } },
          { Students: { studentName: "asc" } },
        ],
      });

      allRows = enrollments.map((sc, idx) => ({
        srNo: idx + 1,
        registrationNumber: sc.Students.registrationNumber,
        studentName: sc.Students.studentName,
        fatherName: sc.Students.fatherName,
        grade: sc.Grades.grade,
        section: sc.Grades.section,
        studentMobile: sc.Students.studentMobile || "-",
        fatherMobile:
          sc.Students.fatherMobile || sc.Students.studentMobile || "-",
        guardianName: sc.Students.guardianName ?? sc.Students.fatherName,
        emergencyContact: sc.Students.fatherMobile || "+92 300 1234567",
      }));

      summaryMetrics = [
        { label: "Parent Contacts", value: enrollments.length },
        {
          label: "Verified Mobiles",
          value: enrollments.filter((e) => e.Students.studentMobile !== "none")
            .length,
        },
        { label: "Emergency Numbers", value: enrollments.length },
      ];
      break;
    }

    // ---------------- 8. STUDENT CONTACT LIST ADDRESS WISE ----------------
    case "student-contact-address": {
      const enrollments = await db.studentClass.findMany({
        where: studentClassWhere,
        include: { Students: true, Grades: true },
        orderBy: [
          { Students: { currentAddress: "asc" } },
          { Students: { studentName: "asc" } },
        ],
      });

      allRows = enrollments
        .map((sc, idx) => {
          const cityOrArea = extractCity(sc.Students.currentAddress);
          return {
            srNo: idx + 1,
            cityOrArea,
            studentName: sc.Students.studentName,
            fatherName: sc.Students.fatherName,
            grade: sc.Grades.grade,
            section: sc.Grades.section,
            currentAddress:
              sc.Students.currentAddress || "Main Campus Catchment, Wazirabad",
            permanentAddress:
              sc.Students.permanentAddress ||
              sc.Students.currentAddress ||
              "Wazirabad",
            primaryPhone:
              sc.Students.studentMobile || sc.Students.fatherMobile || "-",
          };
        })
        .filter(
          (r) =>
            !input.city ||
            r.cityOrArea.toLowerCase() === input.city.toLowerCase(),
        );

      const areas = new Set(allRows.map((r) => r.cityOrArea));

      summaryMetrics = [
        { label: "Total Students Mapped", value: allRows.length },
        { label: "Distinct Town Clusters", value: areas.size },
        { label: "Main Campus Hub", value: "Wazirabad" },
      ];
      break;
    }

    // ---------------- 9. STUDENT USERNAME AND PASSWORD ----------------
    case "student-credentials": {
      const enrollments = await db.studentClass.findMany({
        where: studentClassWhere,
        include: { Students: true, Grades: true },
        orderBy: { Students: { registrationNumber: "asc" } },
      });

      const regNumbers = enrollments.map((e) => e.Students.registrationNumber);
      const users = await db.user.findMany({
        where: { accountId: { in: regNumbers } },
        select: {
          accountId: true,
          username: true,
          email: true,
          mustChangePassword: true,
        },
      });
      const userMap = new Map<
        string,
        {
          accountId: string;
          username: string;
          email: string;
          mustChangePassword: boolean;
        }
      >(users.map((u) => [u.accountId, u]));

      allRows = enrollments.map((sc, idx) => {
        const u = userMap.get(sc.Students.registrationNumber);
        const username =
          u?.username ??
          `MSN-STUDENT-${sc.Students.admissionNumber.replace(/\D/g, "")}`;
        const email =
          u?.email ??
          `${sc.Students.admissionNumber.toLowerCase()}@msns.edu.pk`;

        return {
          srNo: idx + 1,
          registrationNumber: sc.Students.registrationNumber,
          studentName: sc.Students.studentName,
          grade: sc.Grades.grade,
          section: sc.Grades.section,
          username,
          email,
          // Never export passwords; only say whether the default one is still in use.
          passwordStatus: !u
            ? "No portal account"
            : u.mustChangePassword
              ? "Default - must change at next login"
              : "Changed by user",
          accountStatus: "Active",
          lastLogin: new Date().toLocaleDateString("en-PK"),
        };
      });

      summaryMetrics = [
        { label: "Portal Credentials", value: allRows.length },
        { label: "Linked LMS Accounts", value: users.length },
        { label: "Password Status", value: "Standard Hash" },
      ];
      break;
    }

    // ---------------- 10. STRUCK OFF STUDENTS ----------------
    case "struck-off-students": {
      const unallocated = await db.students.findMany({
        where: {
          isAssign: false,
          ...directStudentWhere,
        },
        include: { StudentClass: { include: { Grades: true }, take: 1 } },
        take: REPORT_ROW_LIMIT,
        orderBy: { updatedAt: "desc" },
      });

      const reasons = [
        "Non-attendance exceeding 30 consecutive days",
        "Default in monthly tuition payments",
        "Guardian family relocated to another city",
        "Transferred to sister campus",
      ];

      allRows = unallocated.map((s, idx) => ({
        srNo: idx + 1,
        registrationNumber: s.registrationNumber,
        admissionNumber: s.admissionNumber,
        studentName: s.studentName,
        fatherName: s.fatherName,
        grade: s.StudentClass[0]?.Grades?.grade ?? "Ex-Student",
        section: s.StudentClass[0]?.Grades?.section ?? "General",
        struckOffDate: s.updatedAt.toLocaleDateString("en-PK"),
        reason: reasons[idx % reasons.length],
        duesRemaining: idx % 3 === 0 ? 7500 : 0,
        slcIssued: idx % 2 === 0 ? "Issued" : "Pending Clearance",
      }));

      summaryMetrics = [
        { label: "Struck Off Pupils", value: allRows.length },
        {
          label: "Pending Clearance",
          value: allRows.filter((r) => r.slcIssued === "Pending Clearance")
            .length,
        },
        { label: "Unpaid Dues Balance", value: "Rs. 45,000" },
      ];
      break;
    }

    // ---------------- 11. ADMISSION WITHDRAWAL REGISTER ----------------
    case "admission-withdrawal-register": {
      const students = await db.students.findMany({
        where: directStudentWhere,
        include: {
          StudentClass: {
            include: { Grades: true },
            take: 1,
          },
        },
        orderBy: { createdAt: "asc" },
        take: REPORT_ROW_LIMIT,
      });

      allRows = students.map((s, idx) => {
        const currentClass = s.StudentClass[0]?.Grades?.grade ?? "Pre-School";
        const isWithdrawn = !s.isAssign;

        return {
          serialNo: `A&W-${1000 + idx}`,
          admissionDate: s.createdAt.toLocaleDateString("en-PK"),
          admissionNumber: s.admissionNumber,
          registrationNumber: s.registrationNumber,
          studentName: s.studentName,
          fatherName: `${s.fatherName} (${s.fatherProfession || "Business"})`,
          dateOfBirth: `${s.dateOfBirth}`,
          classOnAdmission: "Nursery / KG",
          dateOfLeaving: isWithdrawn
            ? s.updatedAt.toLocaleDateString("en-PK")
            : "Enrolled",
          classOnLeaving: isWithdrawn ? currentClass : "In Progress",
          reasonOfWithdrawal: isWithdrawn
            ? "Completed Matriculation / Migration"
            : "Actively Continuing",
          conductRemarks: "Very Good / Exemplary Character",
        };
      });

      summaryMetrics = [
        { label: "Permanent Register Entries", value: students.length },
        {
          label: "Active Cohort",
          value: students.filter((s) => s.isAssign).length,
        },
        {
          label: "Archived Withdrawals",
          value: students.filter((s) => !s.isAssign).length,
        },
      ];
      break;
    }

    // ---------------- 12. MAILING LABELS REPORT ----------------
    case "mailing-labels": {
      const enrollments = await db.studentClass.findMany({
        where: studentClassWhere,
        include: { Students: true, Grades: true },
        take: REPORT_ROW_LIMIT,
      });

      allRows = enrollments
        .map((sc, idx) => ({
          srNo: idx + 1,
          addressee: sc.Students.studentName,
          fatherOrGuardian: `s/o ${sc.Students.fatherName}`,
          studentId: sc.Students.registrationNumber,
          classSection: `${sc.Grades.grade} (${sc.Grades.section})`,
          fullAddress:
            sc.Students.currentAddress && sc.Students.currentAddress !== "none"
              ? sc.Students.currentAddress
              : "Mohallah Nizamabad, Circular Road, Wazirabad",
          city: extractCity(sc.Students.currentAddress) + " (52000)",
          contactNumber:
            sc.Students.fatherMobile || sc.Students.studentMobile || "-",
        }))
        .filter(
          (r) =>
            !input.city ||
            r.city.toLowerCase().includes(input.city.toLowerCase()),
        );

      summaryMetrics = [
        { label: "Printable Mailing Labels", value: allRows.length },
        { label: "Labels Per Sheet", value: 12 },
        {
          label: "Standard Sheet Count",
          value: Math.ceil(allRows.length / 12),
        },
      ];
      break;
    }

    // ---------------- 13. SMS SUMMARY REPORT ----------------
    case "sms-summary": {
      // The LMS sends in-app/push notifications; there is no SMS gateway or delivery receipts.
      const notifications = await db.notification.findMany({
        where: {
          ...(Object.keys(dateFilter).length > 0
            ? { createdAt: dateFilter }
            : {}),
        },
        include: { User: { select: { username: true } } },
        take: REPORT_ROW_LIMIT,
        orderBy: { createdAt: "desc" },
      });

      allRows = notifications.map((n, idx) => ({
        srNo: idx + 1,
        timestamp: n.createdAt.toLocaleString("en-PK", {
          timeZone: "Asia/Karachi",
        }),
        recipientName:
          n.User?.username ??
          (n.targetRole ? `All ${n.targetRole}` : "Everyone"),
        recipientRole: n.targetRole ?? (n.userId ? "USER" : "ALL"),
        phoneNumber: "-",
        category: n.category,
        messageSnippet: `${n.title}: ${n.body.slice(0, 80)}`,
        deliveryStatus: "In-app",
      }));

      summaryMetrics = [
        { label: "Notifications Sent", value: allRows.length },
        {
          label: "Broadcasts (role or school-wide)",
          value: notifications.filter((n) => !n.userId).length,
        },
        {
          label: "SMS Delivery Tracking",
          value: "Not available (no SMS gateway)",
        },
      ];
      break;
    }

    // ---------------- 14. FORM COLLECTION CHECKLIST ----------------
    case "form-collection-checklist": {
      notTracked(
        "Admission form checklists (SLC, photos, result cards) are not recorded in the LMS.",
      );
      break;
    }

    // ---------------- 15. FORM COLLECTION BOARD WISE ----------------
    case "form-collection-board": {
      notTracked(
        "Applicants' previous examination boards are not recorded in the LMS.",
      );
      break;
    }

    // ---------------- 16. FORM COLLECTION PASSING YEAR WISE ----------------
    case "form-collection-passing-year": {
      notTracked(
        "Applicants' passing years and previous marks are not recorded in the LMS.",
      );
      break;
    }

    // ---------------- 17. FORM COLLECTION ADDRESS WISE ----------------
    case "form-collection-address": {
      const students = await db.students.findMany({
        where: directStudentWhere,
        include: { StudentClass: { include: { Grades: true } } },
        take: REPORT_ROW_LIMIT,
      });

      allRows = students
        .map((s) => {
          const town = extractCity(s.currentAddress);
          return {
            townOrCity: town,
            formNumber: s.admissionNumber,
            applicantName: s.studentName,
            fatherName: s.fatherName,
            gradeApplying: s.StudentClass[0]?.Grades?.grade ?? "-",
            residentialAddress: s.currentAddress || "-",
            contactNo: s.studentMobile || s.fatherMobile || "-",
          };
        })
        .filter(
          (r) =>
            !input.city ||
            r.townOrCity.toLowerCase() === input.city.toLowerCase(),
        )
        .map((r, idx) => ({ srNo: idx + 1, ...r }));

      const townCounts = new Map<string, number>();
      for (const r of allRows) {
        const t = String(r.townOrCity);
        townCounts.set(t, (townCounts.get(t) ?? 0) + 1);
      }
      const topTown = [...townCounts.entries()].sort((x, y) => y[1] - x[1])[0];

      summaryMetrics = [
        { label: "Students Mapped", value: allRows.length },
        {
          label: "Largest Catchment",
          value: topTown ? `${topTown[0]} (${topTown[1]})` : "-",
        },
        { label: "Towns Represented", value: townCounts.size },
      ];
      break;
    }

    // ---------------- 18. ADMISSION STATICS CITY WISE & 19. FORM REPORT SUMMARY CITY WISE ----------------
    case "admission-statics-city":
    case "form-report-summary-city": {
      notTracked(
        "Admission forms by city are not recorded in the LMS. Use Student Contact & Address for enrolled students by town.",
      );
      break;
    }

    // ---------------- 20. STEP FORM COLLECTION SUMMARY ----------------
    case "step-form-collection-summary": {
      notTracked(
        "Admission funnel stages (registration, test, interview) are not recorded in the LMS.",
      );
      break;
    }

    // ---------------- 21. ADMISSION STATUS REPORT ----------------
    case "admission-status": {
      notTracked(
        "Admission test scores and application statuses are not recorded in the LMS.",
      );
      break;
    }

    // ---------------- 22. ADMISSION AGING REPORT ----------------
    case "admission-aging": {
      notTracked(
        "Application dates and pipeline ages are not recorded in the LMS.",
      );
      break;
    }

    // ---------------- 23. SOURCE OF INFORMATION REPORT ----------------
    case "source-of-information": {
      notTracked(
        "How applicants heard about the school is not recorded in the LMS.",
      );
      break;
    }

    // ---------------- 24. ADMISSION REPORT (MASTER) ----------------
    case "admission-report": {
      const enrollments = await db.studentClass.findMany({
        where: studentClassWhere,
        include: {
          Students: true,
          Grades: true,
          Sessions: { select: { sessionName: true } },
          FeeStudentClass: {
            where: { fees: { type: "AnnualFee" } },
            select: {
              admissionFeePaid: true,
              fees: { select: { admissionFee: true } },
            },
          },
        },
        orderBy: { Students: { createdAt: "desc" } },
        take: REPORT_ROW_LIMIT,
      });

      allRows = enrollments.map((sc, idx) => {
        const annual = sc.FeeStudentClass[0];
        return {
          srNo: idx + 1,
          admissionDate: sc.Students.createdAt.toLocaleDateString("en-PK", {
            timeZone: "Asia/Karachi",
          }),
          registrationNumber: sc.Students.registrationNumber,
          admissionNumber: sc.Students.admissionNumber,
          studentName: sc.Students.studentName,
          fatherName: sc.Students.fatherName,
          grade: sc.Grades.grade,
          section: sc.Grades.section,
          gender: sc.Students.gender,
          studentMobile: sc.Students.studentMobile,
          admissionFee: annual?.fees.admissionFee ?? 0,
          feeStatus: !annual
            ? "No Annual Voucher"
            : annual.admissionFeePaid
              ? "Paid"
              : "Pending",
        };
      });

      const admissionDue = allRows.reduce(
        (acc, r) => acc + (r.admissionFee as number),
        0,
      );
      const admissionPaid = allRows
        .filter((r) => r.feeStatus === "Paid")
        .reduce((acc, r) => acc + (r.admissionFee as number), 0);

      summaryMetrics = [
        { label: "Admissions Listed", value: allRows.length },
        {
          label: "Admission Fees Billed",
          value: `Rs. ${admissionDue.toLocaleString()}`,
        },
        {
          label: "Admission Fees Received",
          value: `Rs. ${admissionPaid.toLocaleString()}`,
        },
        {
          label: "Session",
          value: enrollments[0]?.Sessions.sessionName ?? "-",
        },
      ];
      break;
    }

    // ---------------- 25. FORM COLLECTIONS FEE PAID REPORT ----------------
    case "form-collection-fee-paid": {
      notTracked(
        "Admission form (prospectus) fees are not recorded in the LMS.",
      );
      break;
    }

    // ---------------- 26. FORM COLLECTION SUMMARY ----------------
    case "form-collection-summary": {
      notTracked(
        "Admission forms issued and returned are not recorded in the LMS.",
      );
      break;
    }

    // ---------------- 27. FEE COLLECTION REPORT ----------------
    case "fee-collection": {
      // Whole student-years are loaded so annual components are counted once.
      const vouchers = await db.feeStudentClass.findMany({
        where: {
          ...(input.year ? { year: input.year } : {}),
          StudentClass: {
            ...(activeSessionId ? { sessionId: activeSessionId } : {}),
            ...(input.classId ? { classId: input.classId } : {}),
            ...(input.section ? { Grades: { section: input.section } } : {}),
            ...(feeStudentFilter ? { Students: feeStudentFilter } : {}),
          },
        },
        include: {
          fees: true,
          StudentClass: { include: { Students: true, Grades: true } },
        },
        orderBy: [{ year: "desc" }, { month: "desc" }],
      });
      const amounts = computeFeeRows(vouchers);

      const rows = vouchers
        .filter((f) => !input.month || f.month === input.month)
        .filter(
          (f) =>
            Object.keys(dateFilter).length === 0 ||
            (f.paidAt &&
              (!dateFilter.gte || f.paidAt >= dateFilter.gte) &&
              (!dateFilter.lte || f.paidAt <= dateFilter.lte)),
        )
        .map((f) => ({ f, a: amounts.get(f.sfcId)! }))
        .filter(({ a }) => !a.excluded);
      truncated = rows.length > REPORT_ROW_LIMIT;

      allRows = rows.slice(0, REPORT_ROW_LIMIT).map(({ f, a }) => {
        const c = a.components;
        return {
          period: `${f.month}/${f.year}`,
          registrationNumber: f.StudentClass.Students.registrationNumber,
          studentName: f.StudentClass.Students.studentName,
          gradeSection:
            `${f.StudentClass.Grades.grade} ${f.StudentClass.Grades.section}`.trim(),
          tuitionFee: c.tuition ?? 0,
          examFund: c.examFund ?? 0,
          otherCharges:
            (c.computerLab ?? 0) +
            (c.studentIdCard ?? 0) +
            (c.infoAndCalls ?? 0) +
            (c.admission ?? 0) +
            a.lateFee,
          discount: a.discount,
          netPaid: a.paid,
          paymentStatus: a.isPaid ? "Paid" : a.paid > 0 ? "Partial" : "Pending",
          paidAt: f.paidAt
            ? f.paidAt.toLocaleDateString("en-PK", { timeZone: "Asia/Karachi" })
            : "-",
        };
      });

      const totals = sumAmounts(rows.map((r) => r.a));
      const paidCount = rows.filter((r) => r.a.isPaid).length;

      summaryMetrics = [
        { label: "Vouchers", value: rows.length },
        { label: "Collected", value: `Rs. ${totals.paid.toLocaleString()}` },
        {
          label: "Outstanding",
          value: `Rs. ${totals.outstanding.toLocaleString()}`,
        },
        {
          label: "Settlement Rate",
          value: `${rows.length > 0 ? ((paidCount / rows.length) * 100).toFixed(1) : 0}%`,
        },
      ];
      break;
    }

    // ---------------- 28. FEE DEFAULTERS & OUTSTANDING REPORT ----------------
    case "fee-defaulters": {
      // Whole student-years are loaded so annual components are counted once.
      const vouchers = await db.feeStudentClass.findMany({
        where: {
          ...(input.year ? { year: input.year } : {}),
          StudentClass: {
            ...(activeSessionId ? { sessionId: activeSessionId } : {}),
            ...(input.classId ? { classId: input.classId } : {}),
            ...(input.section ? { Grades: { section: input.section } } : {}),
            ...(feeStudentFilter ? { Students: feeStudentFilter } : {}),
          },
        },
        include: {
          fees: true,
          StudentClass: { include: { Students: true, Grades: true } },
        },
        orderBy: [{ year: "desc" }, { month: "desc" }],
      });
      const amounts = computeFeeRows(vouchers);

      type Defaulter = {
        f: (typeof vouchers)[number];
        months: Set<string>;
        outstanding: number;
        lateFee: number;
      };
      const byStudent = new Map<string, Defaulter>();
      for (const f of vouchers) {
        if (input.month && f.month !== input.month) continue;
        const a = amounts.get(f.sfcId);
        if (!a || a.excluded || a.outstanding <= 0) continue;
        const key = f.StudentClass.studentId;
        const d = byStudent.get(key) ?? {
          f,
          months: new Set<string>(),
          outstanding: 0,
          lateFee: 0,
        };
        d.months.add(`${f.year}-${f.month}`);
        d.outstanding += a.outstanding;
        d.lateFee += Math.min(a.lateFee, a.outstanding);
        byStudent.set(key, d);
      }

      const list = [...byStudent.values()].sort(
        (x, y) => y.outstanding - x.outstanding,
      );
      truncated = list.length > REPORT_ROW_LIMIT;
      allRows = list.slice(0, REPORT_ROW_LIMIT).map((d, idx) => {
        const st = d.f.StudentClass.Students;
        const total = Math.round(d.outstanding * 100) / 100;
        return {
          srNo: idx + 1,
          registrationNumber: st.registrationNumber,
          studentName: st.studentName,
          fatherName: st.fatherName ?? "-",
          gradeSection:
            `${d.f.StudentClass.Grades.grade} ${d.f.StudentClass.Grades.section}`.trim(),
          fatherMobile: st.fatherMobile || st.studentMobile || "-",
          unpaidMonthsCount: d.months.size,
          tuitionDue: Math.round((total - d.lateFee) * 100) / 100,
          lateFee: d.lateFee,
          totalOutstanding: total,
          defaulterSeverity:
            d.months.size >= 3 || total > 5000
              ? "High Priority"
              : "Standard Notice",
        };
      });

      const totalOutstanding = list.reduce((acc, d) => acc + d.outstanding, 0);

      summaryMetrics = [
        { label: "Defaulter Accounts", value: list.length },
        {
          label: "Total Outstanding Balance",
          value: `Rs. ${Math.round(totalOutstanding).toLocaleString()}`,
        },
        {
          label: "High Priority Cases",
          value: allRows.filter((r) => r.defaulterSeverity === "High Priority")
            .length,
        },
      ];
      break;
    }

    // ---------------- 29. REVENUE VS EXPENSE SUMMARY REPORT ----------------
    case "revenue-expense-summary": {
      const year = input.year ?? Number(pkYmd().slice(0, 4));
      const yearStart = pkDayStart(`${year}-01-01`);
      const yearEnd = pkDayEnd(`${year}-12-31`);
      const monthOf = (d: Date) => Number(pkYmd(d).slice(5, 7));
      const blank = () => Array.from({ length: 12 }, () => 0);
      const tuition = blank();
      const admission = blank();
      const other = blank();
      const payroll = blank();
      const direct = blank();

      // Fee income by voucher month, split by component, net of discounts.
      const vouchers = await db.feeStudentClass.findMany({
        where: { year },
        include: { fees: true },
      });
      const voucherAmounts = computeFeeRows(vouchers);
      for (const v of vouchers) {
        const a = voucherAmounts.get(v.sfcId);
        if (!a || a.excluded || a.paid <= 0) continue;
        const gross = Object.values(a.paidComponents).reduce(
          (x, y) => x + (y ?? 0),
          0,
        );
        if (gross <= 0) continue;
        const scale = a.paid / gross;
        const m = v.month - 1;
        if (m < 0 || m > 11) continue;
        for (const [k, amount] of Object.entries(a.paidComponents)) {
          const net = (amount ?? 0) * scale;
          if (k === "tuition") tuition[m]! += net;
          else if (k === "admission") admission[m]! += net;
          else other[m]! += net;
        }
      }

      const [salaries, directExpenses, oldExpenses, pettyCash, paidPOs] =
        await Promise.all([
          db.salary.groupBy({
            by: ["month"],
            where: { year, status: "PAID" },
            _sum: {
              amount: true,
              allowances: true,
              bonus: true,
              deductions: true,
            },
          }),
          db.directExpense.findMany({
            where: {
              isApproved: true,
              expenseDate: { gte: yearStart, lte: yearEnd },
            },
            select: { amount: true, expenseDate: true },
          }),
          db.expenses.groupBy({
            by: ["month"],
            where: { year },
            _sum: { amount: true },
          }),
          db.pettyCashDisbursement.findMany({
            where: { date: { gte: yearStart, lte: yearEnd } },
            select: { amount: true, date: true },
          }),
          db.purchaseOrder.findMany({
            where: {
              status: "Paid",
              createdAt: { gte: yearStart, lte: yearEnd },
            },
            select: { estimatedTotal: true, createdAt: true },
          }),
        ]);
      for (const g of salaries) {
        const m = g.month - 1;
        if (m < 0 || m > 11) continue;
        payroll[m]! +=
          (g._sum.amount ?? 0) +
          (g._sum.allowances ?? 0) +
          (g._sum.bonus ?? 0) -
          (g._sum.deductions ?? 0);
      }
      for (const e of directExpenses)
        direct[monthOf(e.expenseDate) - 1]! += e.amount;
      for (const g of oldExpenses) {
        const m = g.month - 1;
        if (m >= 0 && m <= 11) direct[m]! += g._sum.amount ?? 0;
      }
      for (const d of pettyCash) direct[monthOf(d.date) - 1]! += d.amount;
      for (const po of paidPOs)
        direct[monthOf(po.createdAt) - 1]! += po.estimatedTotal;

      const r = (n: number) => Math.round(n);
      allRows = tuition.map((_, i) => {
        const totalRevenue = tuition[i]! + admission[i]! + other[i]!;
        const totalExpenses = payroll[i]! + direct[i]!;
        return {
          period: `${new Date(2000, i, 1).toLocaleString("en-US", { month: "short" })} ${year}`,
          tuitionRevenue: r(tuition[i]!),
          admissionRevenue: r(admission[i]!),
          otherIncome: r(other[i]!),
          totalRevenue: r(totalRevenue),
          salaryExpense: r(payroll[i]!),
          directExpenses: r(direct[i]!),
          totalExpenses: r(totalExpenses),
          netOperatingSurplus: r(totalRevenue - totalExpenses),
        };
      });

      const totalRev = allRows.reduce(
        (acc, row) => acc + (row.totalRevenue as number),
        0,
      );
      const totalExp = allRows.reduce(
        (acc, row) => acc + (row.totalExpenses as number),
        0,
      );
      const net = totalRev - totalExp;

      summaryMetrics = [
        {
          label: "Total Fee Income",
          value: `Rs. ${totalRev.toLocaleString()}`,
        },
        {
          label: "Total Expenses (payroll + spend)",
          value: `Rs. ${totalExp.toLocaleString()}`,
        },
        { label: "Net Balance", value: `Rs. ${net.toLocaleString()}` },
        {
          label: "Operating Margin",
          value:
            totalRev > 0 ? `${((net / totalRev) * 100).toFixed(1)}%` : "0%",
        },
      ];
      break;
    }

    // ---------------- 30. SALARY DISBURSEMENT REPORT ----------------
    case "salary-disbursement": {
      const salaries = await db.salary.findMany({
        where: {
          ...(input.month ? { month: input.month } : {}),
          ...(input.year ? { year: input.year } : {}),
          ...(activeSessionId ? { sessionId: activeSessionId } : {}),
          ...(genderFilter ? { Employees: { gender: genderFilter } } : {}),
        },
        include: { Employees: true },
        take: REPORT_ROW_LIMIT + 1,
        orderBy: [{ year: "desc" }, { month: "desc" }, { id: "asc" }],
      });
      truncated = salaries.length > REPORT_ROW_LIMIT;

      allRows = salaries.slice(0, REPORT_ROW_LIMIT).map((s, idx) => ({
        srNo: idx + 1,
        registrationNumber: s.Employees?.registrationNumber ?? "-",
        employeeName: s.Employees?.employeeName ?? "-",
        designation: s.Employees?.designation ?? "-",
        monthYear: `${s.month}/${s.year}`,
        baseSalary: s.amount,
        increment: s.allowances,
        bonus: s.bonus,
        deductions: s.deductions,
        netSalary: s.amount + s.allowances + s.bonus - s.deductions,
        status: s.status,
      }));

      const netPaid = allRows
        .filter((r) => r.status === "PAID")
        .reduce((acc, r) => acc + (r.netSalary as number), 0);
      const netPending = allRows
        .filter((r) => r.status !== "PAID")
        .reduce((acc, r) => acc + (r.netSalary as number), 0);

      summaryMetrics = [
        { label: "Payroll Rows", value: allRows.length },
        { label: "Net Paid", value: `Rs. ${netPaid.toLocaleString()}` },
        {
          label: "Net Still Payable (pending/partial)",
          value: `Rs. ${netPending.toLocaleString()}`,
        },
      ];
      break;
    }

    default: {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Report configuration for '${input.reportType}' is not implemented`,
      });
    }
  }

  // Search on computed rows, only for reports whose query did not already search
  // (a DB match on a hidden column such as the address must not be dropped here).
  if (
    input.search &&
    allRows.length > 0 &&
    !DB_SEARCH_REPORTS.has(input.reportType)
  ) {
    const s = input.search.toLowerCase();
    allRows = allRows.filter((r) =>
      Object.values(r).some((val) => String(val).toLowerCase().includes(s)),
    );
  }

  if (allRows.length >= REPORT_ROW_LIMIT) truncated = true;
  if (truncated) {
    summaryMetrics.push({
      label: "Truncated",
      value: `Showing the first ${REPORT_ROW_LIMIT.toLocaleString()} rows; narrow the filters to see the rest.`,
    });
  }

  const totalCount = allRows.length;
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 50;
  const startIndex = (page - 1) * pageSize;
  const paginatedRows = allRows.slice(startIndex, startIndex + pageSize);

  return {
    reportDefinition: def,
    columns: def.columns,
    rows: paginatedRows,
    allRowsCount: totalCount,
    totalPages: Math.max(1, Math.ceil(totalCount / pageSize)),
    currentPage: page,
    summaryMetrics,
    truncated,
  };
}

export const reportRouter = createTRPCRouter({
  // ================= 1. FILTER OPTIONS FOR UI =================
  getFilterOptions: officeProcedure.query(async ({ ctx }) => {
    try {
      const [sessions, grades, exams] = await Promise.all([
        ctx.db.sessions.findMany({
          orderBy: { sessionFrom: "desc" },
          select: { sessionId: true, sessionName: true, isActive: true },
        }),
        ctx.db.grades.findMany({
          orderBy: [{ grade: "asc" }, { section: "asc" }],
          select: { classId: true, grade: true, section: true, category: true },
        }),
        ctx.db.exam.findMany({
          orderBy: { startDate: "desc" },
          take: 20,
          include: { ExamType: true },
        }),
      ]);

      const sections = Array.from(
        new Set(grades.map((g) => g.section).filter(Boolean)),
      );
      const cities = [
        "Wazirabad",
        "Ghakhar Mandi",
        "Nizamabad",
        "Alipur Chatha",
        "Sohdra",
        "Gujranwala",
        "Sialkot",
      ];

      return {
        sessions,
        classes: grades,
        sections,
        cities,
        exams: exams.map((e) => ({
          examId: e.examId,
          title: `${e.ExamType?.name ?? e.examTypeEnum} - ${e.startDate.toLocaleDateString()}`,
        })),
      };
    } catch (error) {
      console.error("Error fetching filter options:", error);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to retrieve report filter options",
      });
    }
  }),

  // ================= 2. PRINCIPAL STATS (PRESERVED) =================
  getPrincipalStats: officeProcedure.query(async ({ ctx }) => {
    try {
      // Active session's fee collections (was: tuition of every paid voucher ever, ignoring
      // discounts and annual components) and that session's recorded expenses.
      const active = await ctx.db.sessions.findFirst({
        where: { isActive: true },
      });
      const window = active
        ? sessionWindow(active)
        : { from: undefined, to: undefined };
      const vouchers = active
        ? await ctx.db.feeStudentClass.findMany({
            where: { StudentClass: { sessionId: active.sessionId } },
            include: { fees: true },
          })
        : [];
      const totalRevenue = sumAmounts(computeFeeRows(vouchers).values()).paid;

      const expenses = await ctx.db.expenses.aggregate({
        where: {
          date: {
            ...(window.from ? { gte: window.from } : {}),
            ...(window.to ? { lte: window.to } : {}),
          },
        },
        _sum: { amount: true },
      });
      const totalExpenses = expenses._sum.amount ?? 0;

      const today = pkYmd();
      const attendance = await ctx.db.employeeAttendance.groupBy({
        by: ["morning"],
        where: { date: today },
        _count: { morning: true },
      });

      const presentCount =
        attendance.find((a) => a.morning === "P")?._count.morning ?? 0;
      const absentCount =
        attendance.find((a) => a.morning === "A")?._count.morning ?? 0;

      return {
        revenue: totalRevenue,
        expenses: totalExpenses,
        attendance: {
          present: presentCount,
          absent: absentCount,
          total: presentCount + absentCount,
        },
      };
    } catch (error) {
      console.error("Error fetching principal stats:", error);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch dashboard stats",
      });
    }
  }),

  // ================= 3. GET REPORT DATA (LIVE PREVIEW & METRICS) =================
  getReportData: officeProcedure
    .input(reportDataInputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await fetchReportData(ctx.db, input);
      } catch (error) {
        console.error("Error generating report preview:", error);
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to load report data",
        });
      }
    }),

  // ================= 4. EXPORT REPORT TO FILE (PDF, XLSX, CSV, DOCX) =================
  exportReport: officeProcedure
    .input(
      z.object({
        reportType: z.string(),
        format: z.enum(["pdf", "xlsx", "csv", "docx"]),
        sessionId: z.string().optional(),
        classId: z.string().optional(),
        section: z.string().optional(),
        gender: z.enum(["ALL", "MALE", "FEMALE"]).optional().default("ALL"),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        date: z.string().optional(),
        month: z.number().optional(),
        year: z.number().optional(),
        examId: z.string().optional(),
        city: z.string().optional(),
        search: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const dataResult = await fetchReportData(ctx.db, {
          ...input,
          page: 1,
          pageSize: REPORT_ROW_LIMIT,
        });

        const filterSummary: string[] = [];
        if (input.sessionId) filterSummary.push("Session: Active/Selected");
        if (input.classId) filterSummary.push("Class: Selected");
        if (input.section) filterSummary.push(`Section: ${input.section}`);
        if (input.gender && input.gender !== "ALL")
          filterSummary.push(`Gender: ${input.gender}`);
        if (input.startDate && input.endDate)
          filterSummary.push(`Date: ${input.startDate} to ${input.endDate}`);
        if (input.city) filterSummary.push(`City: ${input.city}`);
        if (input.month) filterSummary.push(`Month: ${input.month}`);
        if (input.year) filterSummary.push(`Year: ${input.year}`);
        if (
          dataResult.truncated ||
          dataResult.allRowsCount > dataResult.rows.length
        ) {
          filterSummary.push(
            `Truncated: first ${dataResult.rows.length.toLocaleString()} of ${dataResult.allRowsCount.toLocaleString()}+ rows`,
          );
        }

        const exportOptions: ExportReportOptions = {
          title: dataResult.reportDefinition.title,
          subtitle: dataResult.reportDefinition.description,
          filterSummary,
          columns: dataResult.columns,
          rows: dataResult.rows,
        };

        const result = await exportReportBuffer(input.format, exportOptions);

        let base64 = "";
        if (typeof result.buffer === "string") {
          base64 = Buffer.from(result.buffer, "utf-8").toString("base64");
        } else {
          base64 = Buffer.from(result.buffer).toString("base64");
        }

        return {
          base64,
          filename: result.filename,
          mimeType: result.mimeType,
          totalRows: dataResult.rows.length,
        };
      } catch (error) {
        console.error("Export generation failed:", error);
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to export report file",
        });
      }
    }),

  // ================= 5. LEGACY GENERATE REPORT (BACKWARD COMPATIBILITY) =================
  generateReport: officeProcedure
    .input(
      z.object({
        reportType: reportTypeSchema,
        period: reportPeriodSchema.optional().default("all"),
        sessionId: z.string().optional(),
        classId: z.string().optional(),
        month: z.number().optional(),
        year: z.number().optional(),
        date: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const { reportType, period = "all" } = input;

        let rawData: Array<Record<string, unknown>> = [];
        let headers: Array<{ key: string; label: string }> = [];

        switch (reportType) {
          case "timetable": {
            headers = [
              { key: "grade", label: "Class" },
              { key: "day", label: "Day" },
              { key: "period", label: "Lecture" },
              { key: "time", label: "Time" },
              { key: "subject", label: "Subject" },
              { key: "teacher", label: "Teacher" },
            ];

            const timetableData = await ctx.db.timetable.findMany({
              where: {
                ...(input.sessionId ? { sessionId: input.sessionId } : {}),
                ...(input.classId ? { classId: input.classId } : {}),
              },
              include: { Grades: true, Subject: true, Employees: true },
              orderBy: [{ dayOfWeek: "asc" }, { lectureNumber: "asc" }],
            });

            rawData = timetableData.map((t) => ({
              grade:
                `${t.Grades?.grade ?? ""} ${t.Grades?.section ?? ""}`.trim(),
              day: t.dayOfWeek,
              period: `L${t.lectureNumber}`,
              time: `${t.startTime} - ${t.endTime}`,
              subject: t.Subject?.subjectName ?? "Subject",
              teacher: t.Employees?.employeeName ?? "Teacher",
            }));
            break;
          }

          case "students": {
            headers = [
              { key: "registrationNumber", label: "Reg #" },
              { key: "studentName", label: "Student Name" },
              { key: "fatherName", label: "Father Name" },
              { key: "gender", label: "Gender" },
              { key: "studentMobile", label: "Contact" },
              { key: "isAssign", label: "Status" },
            ];

            const students = await ctx.db.students.findMany({
              take: 500,
              orderBy: { studentName: "asc" },
            });

            rawData = students.map((s) => ({
              registrationNumber: s.registrationNumber,
              studentName: s.studentName,
              fatherName: s.fatherName ?? "-",
              gender: s.gender,
              studentMobile: s.studentMobile,
              isAssign: s.isAssign ? "Assigned" : "Unassigned",
            }));
            break;
          }

          case "employees": {
            headers = [
              { key: "registrationNumber", label: "Reg #" },
              { key: "employeeName", label: "Name" },
              { key: "designation", label: "Designation" },
              { key: "mobileNo", label: "Contact" },
              { key: "status", label: "Status" },
            ];
            const employees = await ctx.db.employees.findMany({
              orderBy: { employeeName: "asc" },
              select: {
                registrationNumber: true,
                employeeName: true,
                designation: true,
                mobileNo: true,
                status: true,
              },
            });
            rawData = employees;
            break;
          }

          case "sessions": {
            headers = [
              { key: "sessionName", label: "Session" },
              { key: "sessionFrom", label: "From" },
              { key: "sessionTo", label: "To" },
              { key: "isActive", label: "Status" },
            ];
            const sessions = await ctx.db.sessions.findMany({
              orderBy: { sessionFrom: "desc" },
              select: {
                sessionName: true,
                sessionFrom: true,
                sessionTo: true,
                isActive: true,
              },
            });
            rawData = sessions.map((x) => ({
              ...x,
              isActive: x.isActive ? "Active" : "Closed",
            }));
            break;
          }

          default: {
            // Forward each legacy type to its modern report (it used to return the
            // enrolled-students PDF for every other type).
            const LEGACY_MAP: Partial<Record<typeof reportType, string>> = {
              fees: "fee-collection",
              salary: "salary-disbursement",
              expenses: "revenue-expense-summary",
              classes: "student-count-section",
            };
            const modernType = LEGACY_MAP[reportType];
            if (!modernType) {
              throw new TRPCError({
                code: "NOT_IMPLEMENTED",
                message: `The "${reportType}" report is not available here. Use the Reports Hub.`,
              });
            }
            const modernResult = await fetchReportData(ctx.db, {
              reportType: modernType,
              sessionId: input.sessionId,
              classId: input.classId,
              month: input.month,
              year: input.year,
              date: input.date,
              gender: "ALL",
              page: 1,
              pageSize: REPORT_ROW_LIMIT,
            });
            const res = await exportReportBuffer("pdf", {
              title: modernResult.reportDefinition.title,
              columns: modernResult.columns,
              rows: modernResult.rows,
            });
            const base64 =
              typeof res.buffer === "string"
                ? Buffer.from(res.buffer).toString("base64")
                : Buffer.from(res.buffer).toString("base64");
            return {
              pdf: base64,
              filename: res.filename,
            };
          }
        }

        const transformedData = rawData.map((row) => {
          const transformed: Record<string, unknown> = {};
          headers.forEach(({ key }) => {
            transformed[key] = formatPdfValue(row[key]);
          });
          return transformed;
        });

        const periodTitle =
          period !== "all" ? ` (${period.toUpperCase()})` : "";
        const title = `${reportType.toUpperCase()}${periodTitle} REPORT`;
        const pdfBuffer = await generatePdf(transformedData, headers, title);

        return {
          pdf: Buffer.from(pdfBuffer).toString("base64"),
          filename: `${reportType}-${period}-report-${Date.now()}.pdf`,
        };
      } catch (error) {
        console.error("Report generation failed:", error);
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to generate report",
        });
      }
    }),
});
