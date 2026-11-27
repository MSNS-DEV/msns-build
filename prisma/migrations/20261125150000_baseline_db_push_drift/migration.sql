-- Baseline for schema changes that reached production through `prisma db push`
-- (fee-voucher milestone 1, notifications, device registration, broadcasts,
-- employee status, report-card remarks, profile pictures).
--
-- Every statement is idempotent, so this migration is safe to run whether or not
-- `db push` already created these objects. Existing fee rows get a voucher
-- number of 'V-' || "sfcId".

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "VoucherType" AS ENUM ('REGULAR_INSTALLMENT', 'SUB_INSTALLMENT', 'FULL_YEAR_MERGED', 'FEE_ADJUSTMENT', 'FINE_CHALLAN');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED', 'LOCKED_MERGED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ConcessionCategory" AS ENUM ('NONE', 'RS_10_SCHOLARSHIP', 'A_PLUS_PLUS', 'A_PLUS', 'A_GRADE', 'B_PLUS', 'B_GRADE', 'C_PLUS', 'C_GRADE', 'D_PLUS', 'D_GRADE', 'SIBLING_CONCESSION', 'STAFF_CHILD', 'ORPHAN_WELFARE', 'SUSPENDED_LOW_ATTENDANCE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ConcessionScope" AS ENUM ('SPECIAL_TWO_YEAR', 'GENERAL_ONE_YEAR', 'REFERRAL_ONE_INSTALLMENT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "FineNature" AS ENUM ('LATE_FEE', 'DISCIPLINE', 'ABSENTEEISM', 'LIBRARY_DAMAGE', 'LAB_BREAKAGE', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "NotificationCategory" AS ENUM ('BROADCAST', 'DAILY_TASK', 'SYSTEM', 'FEATURE_EXPLORE', 'FEE', 'ATTENDANCE', 'EXAM');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AlterEnum
ALTER TYPE "ExamTypeEnum" ADD VALUE IF NOT EXISTS 'FIRST_TIME';

-- DropIndex
DROP INDEX IF EXISTS "FeeStudentClass_studentClassId_feeId_month_year_key";

-- AlterTable
ALTER TABLE "Employees" ADD COLUMN IF NOT EXISTS "leftDate" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'Active';

-- AlterTable
ALTER TABLE "FeeStudentClass" ADD COLUMN IF NOT EXISTS "adjustmentAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "adjustmentReason" TEXT,
ADD COLUMN IF NOT EXISTS "admissionFeePaid" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "amountPaid" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "collectingBank" TEXT DEFAULT 'CASH_COUNTER',
ADD COLUMN IF NOT EXISTS "collectorName" TEXT,
ADD COLUMN IF NOT EXISTS "concessionAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "concessionCategory" "ConcessionCategory" NOT NULL DEFAULT 'NONE',
ADD COLUMN IF NOT EXISTS "concessionScope" "ConcessionScope",
ADD COLUMN IF NOT EXISTS "confirmedByUserId" TEXT,
ADD COLUMN IF NOT EXISTS "dueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN IF NOT EXISTS "exemptionAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "exemptionApprovedBy" TEXT,
ADD COLUMN IF NOT EXISTS "exemptionReason" TEXT,
ADD COLUMN IF NOT EXISTS "fineNature" "FineNature",
ADD COLUMN IF NOT EXISTS "installmentNo" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN IF NOT EXISTS "isSplitLocked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN IF NOT EXISTS "mergedIntoVoucherId" TEXT,
ADD COLUMN IF NOT EXISTS "parentVoucherId" TEXT,
ADD COLUMN IF NOT EXISTS "paymentHistory" JSONB DEFAULT '[]',
ADD COLUMN IF NOT EXISTS "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN IF NOT EXISTS "subInstallmentIndex" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN IF NOT EXISTS "totalSubInstallments" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN IF NOT EXISTS "voucherNumber" TEXT,
ADD COLUMN IF NOT EXISTS "voucherType" "VoucherType" NOT NULL DEFAULT 'REGULAR_INSTALLMENT',
ALTER COLUMN "discountDescription" DROP NOT NULL;

-- Backfill voucher numbers for rows that existed before the voucher system, then enforce NOT NULL.
UPDATE "FeeStudentClass" SET "voucherNumber" = 'V-' || "sfcId" WHERE "voucherNumber" IS NULL;
ALTER TABLE "FeeStudentClass" ALTER COLUMN "voucherNumber" SET NOT NULL;

-- AlterTable
ALTER TABLE "ReportCard" ADD COLUMN IF NOT EXISTS "headRemarks" TEXT,
ADD COLUMN IF NOT EXISTS "teacherRemarks" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "profilePic" TEXT DEFAULT '/user.jpg';

-- CreateTable
CREATE TABLE IF NOT EXISTS "ChallanValidity" (
    "challanValidityId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "gradeId" TEXT NOT NULL,
    "installmentNo" INTEGER NOT NULL,
    "month" INTEGER,
    "year" INTEGER NOT NULL,
    "fromDate" TIMESTAMP(3) NOT NULL,
    "toDate" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChallanValidity_pkey" PRIMARY KEY ("challanValidityId")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "SchoolBankDetails" (
    "bankId" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountTitle" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "iban" TEXT,
    "branchCode" TEXT,
    "branchName" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchoolBankDetails_pkey" PRIMARY KEY ("bankId")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Broadcast" (
    "id" TEXT NOT NULL,
    "router" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Broadcast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "DeviceRegistration" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "userId" TEXT,
    "parentGuardianId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "targetRole" "Designation",
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" "NotificationCategory" NOT NULL DEFAULT 'SYSTEM',
    "actionUrl" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ChallanValidity_sessionId_gradeId_idx" ON "ChallanValidity"("sessionId", "gradeId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ChallanValidity_sessionId_gradeId_installmentNo_key" ON "ChallanValidity"("sessionId", "gradeId", "installmentNo");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DeviceRegistration_token_key" ON "DeviceRegistration"("token");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Notification_userId_read_idx" ON "Notification"("userId", "read");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Notification_targetRole_idx" ON "Notification"("targetRole");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Notification_createdAt_idx" ON "Notification"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "FeeStudentClass_voucherNumber_key" ON "FeeStudentClass"("voucherNumber");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FeeStudentClass_studentClassId_idx" ON "FeeStudentClass"("studentClassId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FeeStudentClass_feeId_idx" ON "FeeStudentClass"("feeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FeeStudentClass_month_year_idx" ON "FeeStudentClass"("month", "year");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FeeStudentClass_paymentStatus_idx" ON "FeeStudentClass"("paymentStatus");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FeeStudentClass_voucherNumber_idx" ON "FeeStudentClass"("voucherNumber");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FeeStudentClass_parentVoucherId_idx" ON "FeeStudentClass"("parentVoucherId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FeeStudentClass_mergedIntoVoucherId_idx" ON "FeeStudentClass"("mergedIntoVoucherId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "FeeStudentClass_studentClassId_feeId_month_year_subInstallm_key" ON "FeeStudentClass"("studentClassId", "feeId", "month", "year", "subInstallmentIndex");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "FeeStudentClass" ADD CONSTRAINT "FeeStudentClass_parentVoucherId_fkey" FOREIGN KEY ("parentVoucherId") REFERENCES "FeeStudentClass"("sfcId") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ChallanValidity" ADD CONSTRAINT "ChallanValidity_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Sessions"("sessionId") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ChallanValidity" ADD CONSTRAINT "ChallanValidity_gradeId_fkey" FOREIGN KEY ("gradeId") REFERENCES "Grades"("classId") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "DeviceRegistration" ADD CONSTRAINT "DeviceRegistration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "DeviceRegistration" ADD CONSTRAINT "DeviceRegistration_parentGuardianId_fkey" FOREIGN KEY ("parentGuardianId") REFERENCES "ParentGuardian"("guardentId") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
