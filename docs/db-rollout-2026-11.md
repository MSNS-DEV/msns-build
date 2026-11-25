# Database rollout: November 2026

This branch adds three migrations. Apply them to production **before** deploying the app.

| Migration                               | What it does                                                                                                                                                                                                                                                                                                                                                                               | Production action                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `20261125150000_baseline_db_push_drift` | Captures everything that reached production through `prisma db push` and never had a migration: the fee-voucher columns and enums, `Notification`, `DeviceRegistration`, `Broadcast`, `ChallanValidity`, `SchoolBankDetails`, `Employees.status/leftDate`, report-card remarks, `User.profilePic`. Every statement is idempotent. Fee rows with no voucher number get `'V-' \|\| "sfcId"`. | **Deploy**. Do not mark it as applied. It skips what already exists and fills in anything missing. |
| `20261125160000_auth_hardening`         | `User.mustChangePassword`, `User.tokenVersion`, `NotificationReceipt`, `LoginAttempt`.                                                                                                                                                                                                                                                                                                     | Deploy                                                                                             |
| `20261125170000_data_integrity`         | Unique keys: `Salary(employeeId, month, year)`, `StudentClass(studentId, sessionId)` and `ClassSubject(classId, subjectId, employeeId, sessionId)`. Voucher `subInstallmentIndex` changes so that 0 means the whole voucher (existing non-split rows are set to 0). Adds lookup indexes.                                                                                                   | Deploy, after the duplicate check below                                                            |

These steps were checked locally against three simulated production databases:

- old migrations recorded, then `db push` with the voucher columns;
- the same without the voucher columns, with existing fee rows;
- `db push` only, with no migration history.

In all three, the steps below ended in `migrate status` "up to date" and no difference from `schema.prisma`.

## Steps

Run these from a trusted machine with `DATABASE_URL` set to production. Use the direct connection, not a pooler.

1. **Back up.** Take a Railway snapshot, or run `pg_dump "$DATABASE_URL" -Fc -f msns-pre-2026-11.dump`.

2. **Run the read-only pre-check:**

   ```sh
   psql "$DATABASE_URL" -f docs/db-precheck-2026-11.sql
   ```

   - Query 3 must return **0 rows** for all three tables. If it lists duplicates, resolve each one by hand before continuing (see "Duplicates" below). Otherwise the unique indexes cannot be created and the migration stops.
   - Note the counts from query 4.

3. **Make sure the old migrations are recorded.** Look at query 1:
   - It lists every folder in `prisma/migrations` up to `20260517174137_erp2_0` as finished: nothing to do.
   - It errors because `_prisma_migrations` does not exist, or some of those old migrations are missing: their objects are already in the database through `db push`, so mark each missing one as applied. List the names with `ls prisma/migrations`, then run this for each:
     ```sh
     npx prisma migrate resolve --applied <migration_name>
     ```
     Only resolve migrations dated **up to `20260517174137_erp2_0`**. Never resolve the three new ones: they must run.
   - Any row shows `finished = false` or a `rolled_back_at` value: stop and investigate before continuing.

4. **Deploy:**

   ```sh
   npx prisma migrate deploy
   npx prisma migrate status   # expect: "Database schema is up to date!"
   ```

5. **Verify:**
   - Re-run query 4. The counts must match step 2.
   - Optionally confirm nothing is left over. This should print an empty migration:
     ```sh
     npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script
     ```

6. **Flag default passwords** (from the security changes):

   ```sh
   npx tsx scripts/flag-default-passwords.ts          # dry run: counts accounts
   npx tsx scripts/flag-default-passwords.ts --apply
   ```

7. Deploy the app.

## Duplicates

- **`Salary`**: keep the row whose `status` is `PAID`, or else the newest one. Move any deductions or bonus onto it, then delete the others.
- **`StudentClass`**: a student enrolled twice in one session. Keep the enrolment whose class is correct. Before deleting the other, move its fee vouchers across:
  ```sql
  UPDATE "FeeStudentClass" SET "studentClassId" = '<keep>' WHERE "studentClassId" = '<drop>';
  ```
  Watch for voucher clashes on the same fee and month.
- **`ClassSubject`**: the same teacher allotted twice. Point `Marks` and `SubjectDiary` at the copy you keep (`classSubjectId`), then delete the other.

## If something goes wrong

`migrate deploy` runs each migration in a transaction, so a failed migration leaves no partial changes. This was checked locally with a duplicate salary: the migration rolled back cleanly, and the steps below completed it. Fix the cause (usually a duplicate), then run:

```sh
npx prisma migrate resolve --rolled-back <name>
npx prisma migrate deploy
```

Restore from the step-1 backup only if data was changed outside the migrations.
