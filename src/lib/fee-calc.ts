/**
 * Single source of truth for voucher amounts (server routers, reports and the fee table).
 *
 * Fee model as used in practice:
 * - A MonthlyFee voucher charges tuition for its month.
 * - The annual components (exam fund, computer lab, ID card, info & calls) are charged
 *   once per student per year:
 *     - on the student's AnnualFee voucher for that year, when one exists (plus admission fee);
 *     - otherwise (older data, where the monthly fee structure carries the annual amounts)
 *       on the earliest monthly voucher of that year, and they count as paid when the
 *       flag is set on any voucher of that year.
 * - Split parents (isSplitLocked), merged and cancelled vouchers are excluded from totals;
 *   a sub-installment is priced as its share of the parent.
 */

export type FeeStructure = {
  type?: string | null;
  tuitionFee: number;
  examFund: number;
  computerLabFund?: number | null;
  studentIdCardFee: number;
  infoAndCallsFee: number;
  admissionFee: number;
};

export type FeeRow = {
  sfcId: string;
  studentClassId: string;
  month?: number | null;
  year?: number | null;
  discount: number;
  discountByPercent: number;
  lateFee?: number | null;
  tuitionPaid: boolean;
  examFundPaid: boolean;
  computerLabPaid: boolean;
  studentIdCardPaid: boolean;
  infoAndCallsPaid: boolean;
  admissionFeePaid?: boolean | null;
  voucherType?: string | null;
  paymentStatus?: string | null;
  isSplitLocked?: boolean | null;
  totalSubInstallments?: number | null;
  fees: FeeStructure;
};

export type ComponentKey =
  | "tuition"
  | "examFund"
  | "computerLab"
  | "studentIdCard"
  | "infoAndCalls"
  | "admission";

export const ANNUAL_COMPONENTS: ComponentKey[] = [
  "examFund",
  "computerLab",
  "studentIdCard",
  "infoAndCalls",
];

export type VoucherAmounts = {
  /** Excluded from totals (split parent, merged or cancelled). */
  excluded: boolean;
  /** Components charged on this voucher with their amounts. */
  components: Partial<Record<ComponentKey, number>>;
  /** Components charged on this voucher that are paid. */
  paidComponents: Partial<Record<ComponentKey, number>>;
  base: number;
  discount: number;
  lateFee: number;
  due: number;
  paid: number;
  outstanding: number;
  isPaid: boolean;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

const isExcluded = (r: FeeRow) =>
  !!r.isSplitLocked ||
  r.paymentStatus === "LOCKED_MERGED" ||
  r.paymentStatus === "CANCELLED";

const isAnnualFee = (r: FeeRow) => r.fees.type === "AnnualFee";

const annualAmounts = (f: FeeStructure): Record<ComponentKey, number> => ({
  tuition: 0,
  examFund: f.examFund ?? 0,
  computerLab: f.computerLabFund ?? 0,
  studentIdCard: f.studentIdCardFee ?? 0,
  infoAndCalls: f.infoAndCallsFee ?? 0,
  admission: f.admissionFee ?? 0,
});

const flagOf = (r: FeeRow, k: ComponentKey): boolean => {
  switch (k) {
    case "tuition":
      return r.tuitionPaid;
    case "examFund":
      return r.examFundPaid;
    case "computerLab":
      return r.computerLabPaid;
    case "studentIdCard":
      return r.studentIdCardPaid;
    case "infoAndCalls":
      return r.infoAndCallsPaid;
    case "admission":
      return !!r.admissionFeePaid;
  }
};

const emptyAmounts = (r: FeeRow): VoucherAmounts => ({
  excluded: true,
  components: {},
  paidComponents: {},
  base: 0,
  discount: 0,
  lateFee: r.lateFee ?? 0,
  due: 0,
  paid: 0,
  outstanding: 0,
  isPaid: true,
});

/** Builds amounts for one voucher given which components it carries and how paid is decided. */
function amountsFor(
  r: FeeRow,
  charged: ComponentKey[],
  isComponentPaid: (k: ComponentKey) => boolean,
): VoucherAmounts {
  const all = annualAmounts(r.fees);
  all.tuition = r.fees.tuitionFee ?? 0;
  const share =
    r.voucherType === "SUB_INSTALLMENT" && (r.totalSubInstallments ?? 1) > 1
      ? 1 / (r.totalSubInstallments ?? 1)
      : 1;

  const components: Partial<Record<ComponentKey, number>> = {};
  const paidComponents: Partial<Record<ComponentKey, number>> = {};
  let base = 0;
  let grossPaid = 0;
  let allPaid = true;
  for (const k of charged) {
    const amount = round2(all[k] * share);
    if (amount <= 0) continue;
    components[k] = amount;
    base += amount;
    if (isComponentPaid(k)) {
      paidComponents[k] = amount;
      grossPaid += amount;
    } else {
      allPaid = false;
    }
  }

  const pct = Math.min(Math.max(r.discountByPercent ?? 0, 0), 100);
  const discount = Math.min(
    Math.max((r.discount ?? 0) + (base * pct) / 100, 0),
    base,
  );
  const lateFee = Math.max(r.lateFee ?? 0, 0);
  const due = round2(base - discount + lateFee);
  // Discounts reduce what is owed, so a fully-paid voucher collected `due`, not the gross amount.
  const paid = base > 0 && allPaid ? due : round2(Math.min(grossPaid, due));
  const outstanding = round2(Math.max(due - paid, 0));
  return {
    excluded: false,
    components,
    paidComponents,
    base: round2(base),
    discount: round2(discount),
    lateFee,
    due,
    paid,
    outstanding,
    isPaid: outstanding <= 0.005,
  };
}

/**
 * Computes amounts for a set of vouchers. Pass every voucher of the student-years you care
 * about (not just one month) so annual components are attributed exactly once.
 */
export function computeFeeRows<T extends FeeRow>(rows: T[]): Map<string, VoucherAmounts> {
  const out = new Map<string, VoucherAmounts>();
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const key = `${r.studentClassId}:${r.year ?? ""}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }

  for (const group of groups.values()) {
    const live = group.filter((r) => !isExcluded(r));
    const hasAnnualVoucher = live.some(isAnnualFee);
    // Older data: annual amounts ride on the monthly fee structure. Charge them once,
    // on the earliest monthly voucher of the year that carries any annual amount.
    let legacyHost: T | undefined;
    if (!hasAnnualVoucher) {
      for (const r of live) {
        if (r.voucherType === "SUB_INSTALLMENT") continue;
        const a = annualAmounts(r.fees);
        const carries = ANNUAL_COMPONENTS.some((k) => a[k] > 0);
        if (!carries) continue;
        if (!legacyHost || (r.month ?? 0) < (legacyHost.month ?? 0)) legacyHost = r;
      }
    }
    const paidAnywhere = (k: ComponentKey) => live.some((r) => flagOf(r, k));

    for (const r of group) {
      if (isExcluded(r)) {
        out.set(r.sfcId, emptyAmounts(r));
        continue;
      }
      if (isAnnualFee(r)) {
        out.set(
          r.sfcId,
          amountsFor(r, [...ANNUAL_COMPONENTS, "admission"], (k) => flagOf(r, k)),
        );
      } else if (r === legacyHost) {
        out.set(
          r.sfcId,
          amountsFor(r, ["tuition", ...ANNUAL_COMPONENTS], (k) =>
            k === "tuition" ? r.tuitionPaid : paidAnywhere(k),
          ),
        );
      } else {
        out.set(r.sfcId, amountsFor(r, ["tuition"], (k) => flagOf(r, k)));
      }
    }
  }
  return out;
}

/** Convenience for a single voucher (annual components only if it is an AnnualFee voucher). */
export function computeVoucher(row: FeeRow): VoucherAmounts {
  if (isExcluded(row)) return emptyAmounts(row);
  return isAnnualFee(row)
    ? amountsFor(row, [...ANNUAL_COMPONENTS, "admission"], (k) => flagOf(row, k))
    : amountsFor(row, ["tuition"], (k) => flagOf(row, k));
}

/** Sums due/paid over computed rows. */
export function sumAmounts(amounts: Iterable<VoucherAmounts>) {
  let due = 0;
  let paid = 0;
  let discount = 0;
  let lateFee = 0;
  for (const a of amounts) {
    if (a.excluded) continue;
    due += a.due;
    paid += a.paid;
    discount += a.discount;
    lateFee += a.lateFee;
  }
  return {
    due: round2(due),
    paid: round2(paid),
    outstanding: round2(Math.max(due - paid, 0)),
    discount: round2(discount),
    lateFee: round2(lateFee),
  };
}
