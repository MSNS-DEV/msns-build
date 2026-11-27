-- Read-only pre-check for the 2026-11 migrations. Run with psql against production.
-- Nothing here writes. Each query is explained in docs/db-rollout-2026-11.md.

-- 1. Migration history (an error "relation does not exist" means there is none: see step 3).
SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at
FROM "_prisma_migrations" ORDER BY started_at;

-- 2. Objects that `db push` may already have created (informational; the baseline handles both cases).
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('Notification', 'DeviceRegistration', 'Broadcast', 'ChallanValidity',
                     'SchoolBankDetails', 'NotificationReceipt', 'LoginAttempt')
ORDER BY 1;
SELECT column_name, is_nullable FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'FeeStudentClass'
  AND column_name IN ('voucherNumber', 'subInstallmentIndex', 'paymentStatus', 'admissionFeePaid')
ORDER BY 1;

-- 3. Duplicates that would block the new unique keys. Every query must return 0 rows.
SELECT 'Salary' AS tbl, "employeeId", "month", "year", count(*) AS copies
FROM "Salary" GROUP BY "employeeId", "month", "year" HAVING count(*) > 1;

SELECT 'StudentClass' AS tbl, "studentId", "sessionId", count(*) AS copies
FROM "StudentClass" GROUP BY "studentId", "sessionId" HAVING count(*) > 1;

SELECT 'ClassSubject' AS tbl, "classId", "subjectId", "employeeId", "sessionId", count(*) AS copies
FROM "ClassSubject" GROUP BY "classId", "subjectId", "employeeId", "sessionId" HAVING count(*) > 1;

-- 4. Row counts for the backup sanity check afterwards.
SELECT
  (SELECT count(*) FROM "FeeStudentClass") AS fee_vouchers,
  (SELECT count(*) FROM "Salary") AS salaries,
  (SELECT count(*) FROM "StudentClass") AS enrolments;
