/** Phone/email normalisation and masking for OTP delivery. */

/**
 * Normalise a phone number to E.164. Pakistani formats are accepted:
 * 03001234567, 3001234567, 923001234567, +92 300 1234567, 0092300...
 * Other countries must be entered with a leading "+".
 */
export function normalisePhone(input: string): string | null {
  const raw = input.trim();
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return null;

  let e164: string;
  if (raw.startsWith("+")) e164 = `+${digits}`;
  else if (digits.startsWith("0092")) e164 = `+${digits.slice(2)}`;
  else if (digits.startsWith("92") && digits.length === 12) e164 = `+${digits}`;
  else if (digits.startsWith("03") && digits.length === 11)
    e164 = `+92${digits.slice(1)}`;
  else if (digits.startsWith("3") && digits.length === 10)
    e164 = `+92${digits}`;
  else return null;

  // Pakistani mobiles: +92 3xx xxxxxxx
  if (e164.startsWith("+92")) {
    return /^\+923\d{9}$/.test(e164) ? e164 : null;
  }
  return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : null;
}

export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  return `${phone.slice(0, 4)} ••• ••${phone.slice(-3)}`;
}

export function normaliseEmail(input: string): string | null {
  const email = input.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254
    ? email
    : null;
}

export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const [name = "", domain = ""] = email.split("@");
  return `${name.slice(0, 2)}${"•".repeat(Math.max(1, name.length - 2))}@${domain}`;
}
