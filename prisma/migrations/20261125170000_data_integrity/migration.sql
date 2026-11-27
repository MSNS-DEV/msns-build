-- Data-integrity constraints and missing indexes.
--
-- BEFORE deploying, run the duplicate pre-check in docs/db-rollout-2026-11.md.
-- The three unique indexes below fail if duplicate rows already exist.

-- Vouchers: index 0 is the whole voucher; sub-installments of a split parent use 1..N.
-- Previously the parent and its first sub-installment both used 1 and collided on the unique key.
ALTER TABLE "FeeStudentClass" ALTER COLUMN "subInstallmentIndex" SET DEFAULT 0;
UPDATE "FeeStudentClass" SET "subInstallmentIndex" = 0
WHERE "voucherType" <> 'SUB_INSTALLMENT' AND "subInstallmentIndex" = 1;

-- Redundant: "FeeStudentClass_voucherNumber_key" already indexes this column.
DROP INDEX IF EXISTS "FeeStudentClass_voucherNumber_idx";

-- CreateIndex
CREATE INDEX "ClassSubject_employeeId_idx" ON "ClassSubject"("employeeId");

-- CreateIndex
CREATE INDEX "ClassSubject_sessionId_idx" ON "ClassSubject"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "ClassSubject_classId_subjectId_employeeId_sessionId_key" ON "ClassSubject"("classId", "subjectId", "employeeId", "sessionId");

-- CreateIndex
CREATE INDEX "Expenses_date_idx" ON "Expenses"("date");

-- CreateIndex
CREATE INDEX "FinancialLedgerEntry_accountCode_idx" ON "FinancialLedgerEntry"("accountCode");

-- CreateIndex
CREATE INDEX "FinancialLedgerEntry_transactionDate_idx" ON "FinancialLedgerEntry"("transactionDate");

-- CreateIndex
CREATE INDEX "Marks_studentId_idx" ON "Marks"("studentId");

-- CreateIndex
CREATE INDEX "Salary_sessionId_year_idx" ON "Salary"("sessionId", "year");

-- CreateIndex
CREATE UNIQUE INDEX "Salary_employeeId_month_year_key" ON "Salary"("employeeId", "month", "year");

-- CreateIndex
CREATE INDEX "StudentClass_classId_idx" ON "StudentClass"("classId");

-- CreateIndex
CREATE INDEX "StudentClass_sessionId_idx" ON "StudentClass"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentClass_studentId_sessionId_key" ON "StudentClass"("studentId", "sessionId");

