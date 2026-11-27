/**
 * Pluggable SMS sending. Choose with SMS_PROVIDER:
 *  - "smsgate" (default): SMS Gateway for Android (https://sms-gate.app) —
 *    sends through an Android phone's SIM, so the only cost is the SIM's bundle.
 *  - "twilio": Twilio REST API.
 *  - "console": development only; prints the message to the server log.
 */
import { SecurityConfigError } from "~/server/security/crypto";

export type SmsResult = { provider: string; messageId?: string };

export interface SmsProvider {
  name: string;
  /** Throws on failure. `to` is E.164. */
  send(to: string, text: string): Promise<SmsResult>;
}

const TIMEOUT_MS = 10_000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new SecurityConfigError(
      `${name} is not set, so SMS codes can't be sent. See docs/two-factor-setup.md.`,
    );
  }
  return value;
}

const smsGate: SmsProvider = {
  name: "smsgate",
  async send(to, text) {
    const base = (
      process.env.SMS_GATE_URL ?? "https://api.sms-gate.app"
    ).replace(/\/+$/, "");
    const username = requireEnv("SMS_GATE_USERNAME");
    const password = requireEnv("SMS_GATE_PASSWORD");
    const res = await fetch(`${base}/3rdparty/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
      },
      body: JSON.stringify({
        textMessage: { text },
        phoneNumbers: [to],
        // Drop the message if the phone can't send it within 5 minutes:
        // the code would have expired anyway.
        ttl: 300,
        // >= 100 skips the app's sending delays.
        priority: 100,
        withDeliveryReport: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`SMS gateway responded ${res.status}`);
    }
    // The response shape isn't relied upon; keep the id if present for logs.
    const body = (await res.json().catch(() => null)) as { id?: string } | null;
    return { provider: "smsgate", messageId: body?.id };
  },
};

const twilio: SmsProvider = {
  name: "twilio",
  async send(to, text) {
    const sid = requireEnv("TWILIO_ACCOUNT_SID");
    const token = requireEnv("TWILIO_AUTH_TOKEN");
    const from = requireEnv("TWILIO_FROM");
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
        },
        body: new URLSearchParams({ To: to, From: from, Body: text }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res.ok) throw new Error(`Twilio responded ${res.status}`);
    const body = (await res.json().catch(() => null)) as {
      sid?: string;
    } | null;
    return { provider: "twilio", messageId: body?.sid };
  },
};

const consoleProvider: SmsProvider = {
  name: "console",
  async send(to, text) {
    if (process.env.NODE_ENV === "production") {
      throw new SecurityConfigError(
        "SMS_PROVIDER=console is for development only. Configure smsgate or twilio.",
      );
    }
    console.info(`[sms:console] to ${to}: ${text}`);
    return { provider: "console" };
  },
};

export function getSmsProvider(): SmsProvider {
  const name = (process.env.SMS_PROVIDER ?? "smsgate").toLowerCase();
  if (name === "twilio") return twilio;
  if (name === "console") return consoleProvider;
  return smsGate;
}

/** True when SMS sending looks configured (used to show/hide the SMS option). */
export function smsConfigured(): boolean {
  const name = (process.env.SMS_PROVIDER ?? "smsgate").toLowerCase();
  if (name === "console") return process.env.NODE_ENV !== "production";
  if (name === "twilio")
    return !!(
      process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_FROM
    );
  return !!(process.env.SMS_GATE_USERNAME && process.env.SMS_GATE_PASSWORD);
}
