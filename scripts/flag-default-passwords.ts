/**
 * One-off: mark every account whose password is still its generated default
 * (the admission number) so it must be changed at next login.
 *
 *   npx tsx scripts/flag-default-passwords.ts          # dry run: counts only
 *   npx tsx scripts/flag-default-passwords.ts --apply  # sets mustChangePassword
 *
 * Run after applying migration 20261125160000_auth_hardening. Reads DATABASE_URL.
 */
import { PrismaClient } from "@prisma/client";
import { compare } from "bcryptjs";

const db = new PrismaClient();
const apply = process.argv.includes("--apply");

async function main() {
  const [students, employees] = await Promise.all([
    db.students.findMany({ select: { registrationNumber: true, admissionNumber: true } }),
    db.employees.findMany({ select: { registrationNumber: true, admissionNumber: true } }),
  ]);
  const defaultByAccountId = new Map<string, string>();
  for (const p of [...students, ...employees]) {
    defaultByAccountId.set(p.registrationNumber, p.admissionNumber);
  }

  const users = await db.user.findMany({
    where: { mustChangePassword: false },
    select: { id: true, accountId: true, accountType: true, password: true },
  });

  const flagged: { id: string; accountType: string }[] = [];
  for (const u of users) {
    const candidate = defaultByAccountId.get(u.accountId);
    if (candidate && (await compare(candidate, u.password))) {
      flagged.push({ id: u.id, accountType: u.accountType });
    }
  }

  const byRole = flagged.reduce<Record<string, number>>((acc, u) => {
    acc[u.accountType] = (acc[u.accountType] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`Accounts still on the default password: ${flagged.length}`, byRole);

  if (apply && flagged.length > 0) {
    const res = await db.user.updateMany({
      where: { id: { in: flagged.map((u) => u.id) } },
      data: { mustChangePassword: true },
    });
    console.log(`Flagged ${res.count} accounts (mustChangePassword = true).`);
  } else if (!apply) {
    console.log("Dry run. Re-run with --apply to flag them.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
