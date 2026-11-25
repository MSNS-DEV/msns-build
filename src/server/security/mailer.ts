import nodemailer, { type Transporter } from "nodemailer";
import { SecurityConfigError } from "./crypto";

export function emailConfigured(): boolean {
  return !!(
    process.env.SMTP_HOST &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS
  );
}

let transport: Transporter | null = null;

function getTransport() {
  if (!emailConfigured()) {
    throw new SecurityConfigError(
      "SMTP_HOST, SMTP_USER and SMTP_PASS must be set to send email codes.",
    );
  }
  transport ??= nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: Number(process.env.SMTP_PORT ?? 587) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transport;
}

/** Plain-text only, so no user data can be interpreted as HTML. */
export async function sendCodeEmail(to: string, subject: string, text: string) {
  if (process.env.SMS_PROVIDER === "console" && !emailConfigured()) {
    if (process.env.NODE_ENV === "production") {
      throw new SecurityConfigError("Email is not configured.");
    }
    console.info(`[email:console] to ${to}: ${subject} — ${text}`);
    return;
  }
  await getTransport().sendMail({
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
    to,
    subject,
    text,
  });
}
