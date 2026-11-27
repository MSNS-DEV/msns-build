/**
 * Date helpers in school time (Asia/Karachi, UTC+5, no daylight saving).
 * Server code runs in UTC on Vercel, so `new Date("YYYY-MM-DD")` or `setHours(0)` would put
 * day boundaries at 05:00 local time. Use these instead.
 */

export const SCHOOL_TIME_ZONE = "Asia/Karachi";

const ymdFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: SCHOOL_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Calendar date (YYYY-MM-DD) of `date` in school time. */
export function pkYmd(date: Date = new Date()): string {
  return ymdFormatter.format(date);
}

/** Accepts a YYYY-MM-DD string or a Date (whose school-time calendar date is used). */
const toYmd = (d: string | Date): string => {
  if (typeof d === "string") {
    const s = d.slice(0, 10);
    if (!YMD.test(s)) throw new Error(`Invalid date: ${d}`);
    return s;
  }
  return pkYmd(d);
};

/** First instant of the school-time day. */
export function pkDayStart(d: string | Date): Date {
  return new Date(`${toYmd(d)}T00:00:00.000+05:00`);
}

/** Last instant of the school-time day. */
export function pkDayEnd(d: string | Date): Date {
  return new Date(`${toYmd(d)}T23:59:59.999+05:00`);
}

/** Midnight UTC of the school-time calendar date — for @db.Date-style "date only" columns. */
export function pkDateOnly(d: string | Date = new Date()): Date {
  return new Date(`${toYmd(d)}T00:00:00.000Z`);
}

/** Session window from its "YYYY-MM-DD" sessionFrom/sessionTo strings (undefined when unset). */
export function sessionWindow(session: {
  sessionFrom: string;
  sessionTo: string;
}) {
  const from = YMD.test(session.sessionFrom.slice(0, 10))
    ? pkDayStart(session.sessionFrom)
    : undefined;
  const to = YMD.test(session.sessionTo.slice(0, 10))
    ? pkDayEnd(session.sessionTo)
    : undefined;
  return { from, to };
}
