import {
  CredentialsSignin,
  type DefaultSession,
  type NextAuthConfig,
} from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { db } from "~/server/db";
import { compare } from "bcryptjs";
import {
  accountKey,
  clearFailedLogins,
  clientIp,
  ipKey,
  isLocked,
  recordFailedLogin,
} from "./login-throttle";
import {
  loadAccount,
  type Principal,
  type PrincipalAccount,
} from "~/server/security/principal";
import { enrollmentRequired, signInState } from "~/server/security/signin";
import { createAuthSession } from "~/server/security/sessions";
import { logSecurityEvent, metaFromHeaders } from "~/server/security/events";
import { redeemPasskeyLoginToken } from "~/server/security/webauthn";

/** How often an active session is re-checked against the database. */
const REVALIDATE_MS = 5 * 60 * 1000;

/**
 * bcrypt hash of a random value, compared against when the account doesn't
 * exist so that response time doesn't reveal which emails are registered.
 */
const DUMMY_HASH =
  "$2b$10$L3yLEiqImnCQ3/e0kmwTbu0PYY0vpQJtNr8d.lO1HpLJLpvgxvZw.";

/** Shown on the sign-in form when a correct password belongs to a suspended account. */
class AccountSuspended extends CredentialsSignin {
  code = "suspended";
}

declare module "next-auth" {
  interface Session extends DefaultSession {
    /** Server-side AuthSession id for this browser/device. */
    sessionId?: string;
    user: {
      id: string;
      email: string;
      username: string;
      accountId: string;
      accountType: string;
      mustChangePassword: boolean;
      /** Password accepted; a second factor is still needed. */
      twoFactorPending: boolean;
      /** The role requires 2FA and this account has none yet. */
      twoFactorEnrollRequired: boolean;
    } & DefaultSession["user"];
  }

  interface User {
    username: string;
    accountId: string;
    accountType: string;
    mustChangePassword?: boolean;
    tokenVersion?: number;
    sid?: string;
    mfaPending?: boolean;
    enrollRequired?: boolean;
  }
}

type AppToken = {
  id?: string;
  email?: string | null;
  accountId?: string;
  accountType?: string;
  username?: string;
  mustChangePassword?: boolean;
  tokenVersion?: number;
  checkedAt?: number;
  sid?: string;
  mfaPending?: boolean;
  enrollRequired?: boolean;
};

function principalOf(token: AppToken): Principal | null {
  if (!token.id) return null;
  return {
    id: token.id,
    type: token.accountType === "PARENT" ? "PARENT" : "USER",
  };
}

/**
 * Re-read the account and device session behind a token. Returns null when
 * the account was removed or suspended, its sessions were revoked
 * (tokenVersion bump), or this device's session was signed out.
 */
async function revalidateToken<T extends AppToken>(
  token: T,
): Promise<T | null> {
  const principal = principalOf(token);
  // Tokens issued before server-side sessions existed have no sid: sign in again.
  if (!principal || !token.sid) return null;

  const [account, authSession] = await Promise.all([
    loadAccount(principal),
    db.authSession.findUnique({ where: { id: token.sid } }),
  ]);
  if (!account?.isActive) return null;
  if ((token.tokenVersion ?? 0) !== account.tokenVersion) return null;
  if (
    !authSession ||
    authSession.revokedAt ||
    authSession.principalId !== principal.id
  ) {
    return null;
  }
  if (principal.type === "USER" && account.role === "STUDENT") {
    // Student records can be deleted while the User row remains.
    const student = await db.students.findUnique({
      where: { registrationNumber: account.accountId },
      select: { studentId: true },
    });
    if (!student) return null;
  }

  const mfaPending = authSession.mfaPending;
  const enrollRequired = mfaPending ? false : await enrollmentRequired(account);
  await db.authSession.update({
    where: { id: authSession.id },
    data: { lastSeenAt: new Date() },
  });

  return {
    ...token,
    accountId: account.accountId,
    accountType: principal.type === "PARENT" ? "PARENT" : account.role,
    username: account.displayName,
    email: account.email ?? "",
    mustChangePassword: account.mustChangePassword,
    mfaPending,
    enrollRequired,
    checkedAt: Date.now(),
  };
}

/** Build the NextAuth user for a principal that passed the first factor. */
async function startSession(
  account: PrincipalAccount,
  request: Request | undefined,
  options: { viaPasskey: boolean },
) {
  const meta = metaFromHeaders(request?.headers);
  const state = options.viaPasskey
    ? { mfaPending: false, enrollRequired: false }
    : await signInState(account, request?.headers.get("cookie"));
  const method = options.viaPasskey ? "passkey" : "password";
  const session = await createAuthSession({
    principal: account,
    meta,
    mfaPending: state.mfaPending,
    method,
  });
  await logSecurityEvent(
    account,
    options.viaPasskey
      ? "login.passkey"
      : state.mfaPending
        ? "login.password_ok_2fa_pending"
        : "login.success",
    meta,
  );
  return {
    id: account.id,
    email: account.email ?? "",
    username: account.displayName,
    accountId: account.accountId,
    accountType: account.type === "PARENT" ? "PARENT" : account.role,
    mustChangePassword: account.mustChangePassword,
    tokenVersion: account.tokenVersion,
    sid: session.id,
    mfaPending: state.mfaPending,
    enrollRequired: state.enrollRequired,
  };
}

export const authConfig = {
  session: {
    strategy: "jwt",
    // Sliding 7-day session: refreshed while in use, expires after a week idle.
    maxAge: 7 * 24 * 60 * 60,
  },
  providers: [
    CredentialsProvider({
      id: "credentials",
      name: "Credentials",
      credentials: {
        email: {
          label: "Email",
          type: "email",
          placeholder: "Enter your email",
        },
        password: {
          label: "Password",
          type: "password",
          placeholder: "Enter your password",
        },
      },
      async authorize(credentials, request) {
        const { email, password } = (credentials ?? {}) as {
          email?: string;
          password?: string;
        };
        if (!email || !password) return null;

        const ip = clientIp(request);
        const keys = [accountKey(email), ...(ip ? [ipKey(ip)] : [])];
        let principal: Principal | null = null;
        try {
          if (await isLocked(keys)) {
            // Too many failures: refuse without checking the password.
            return null;
          }

          let passwordHash: string | undefined;
          if (email.includes("@")) {
            const user = await db.user.findUnique({
              where: { email: email.trim().toLowerCase() },
              select: { id: true, password: true },
            });
            if (user) principal = { id: user.id, type: "USER" };
            passwordHash = user?.password;
          } else {
            const parent = await db.parentGuardian.findUnique({
              where: { username: email },
              select: { guardentId: true, passwordHash: true },
            });
            if (parent) principal = { id: parent.guardentId, type: "PARENT" };
            passwordHash = parent?.passwordHash;
          }

          const isValidPassword = await compare(
            password,
            passwordHash ?? DUMMY_HASH,
          );
          if (!principal || !isValidPassword) {
            await recordFailedLogin(email, ip);
            if (principal) {
              await logSecurityEvent(
                principal,
                "login.failed",
                metaFromHeaders(request?.headers),
              );
            }
            return null;
          }

          const account = await loadAccount(principal);
          if (!account) return null;
          if (!account.isActive) {
            await logSecurityEvent(
              principal,
              "login.blocked_suspended",
              metaFromHeaders(request?.headers),
            );
            throw new AccountSuspended();
          }
          await clearFailedLogins(email);
          return await startSession(account, request, { viaPasskey: false });
        } catch (error) {
          if (error instanceof CredentialsSignin) throw error;
          console.error("Auth error:", error);
          return null;
        }
      },
    }),
    CredentialsProvider({
      // Passwordless sign-in: the token comes from security.passkeyLoginVerify.
      id: "passkey",
      name: "Passkey",
      credentials: { token: { label: "Token", type: "text" } },
      async authorize(credentials, request) {
        const token = (credentials as { token?: string } | undefined)?.token;
        if (!token) return null;
        try {
          const principal = await redeemPasskeyLoginToken(token);
          if (!principal) return null;
          const account = await loadAccount(principal);
          if (!account) return null;
          if (!account.isActive) throw new AccountSuspended();
          return await startSession(account, request, { viaPasskey: true });
        } catch (error) {
          if (error instanceof CredentialsSignin) throw error;
          console.error("Passkey auth error:", error);
          return null;
        }
      },
    }),
  ],
  callbacks: {
    async session({ session, token }) {
      const t = token as typeof token & AppToken;
      return {
        ...session,
        sessionId: t.sid,
        user: {
          ...session.user,
          id: t.id!,
          email: t.email ?? "",
          accountType: t.accountType!,
          accountId: t.accountId!,
          username: t.username!,
          mustChangePassword: Boolean(t.mustChangePassword),
          twoFactorPending: Boolean(t.mfaPending),
          twoFactorEnrollRequired: Boolean(t.enrollRequired),
        },
      };
    },
    async jwt({ token, user, trigger }) {
      if (user) {
        return {
          ...token,
          id: user.id,
          email: user.email,
          accountId: user.accountId,
          accountType: user.accountType,
          username: user.username,
          mustChangePassword: Boolean(user.mustChangePassword),
          tokenVersion: user.tokenVersion ?? 0,
          sid: user.sid,
          mfaPending: Boolean(user.mfaPending),
          enrollRequired: Boolean(user.enrollRequired),
          checkedAt: Date.now(),
        };
      }
      const t = token as typeof token & AppToken;
      const stale =
        trigger === "update" ||
        t.mustChangePassword === true ||
        t.mfaPending === true ||
        t.enrollRequired === true ||
        !t.checkedAt ||
        Date.now() - t.checkedAt > REVALIDATE_MS;
      if (!stale) return token;
      try {
        return await revalidateToken(t);
      } catch (error) {
        // Database unreachable: keep the session rather than logging everyone
        // out, but never let a pending second factor through.
        console.error("Session revalidation failed:", error);
        return t.mfaPending ? null : token;
      }
    },
  },
  events: {
    /** Signing out ends this device's server-side session too. */
    async signOut(message) {
      const sid =
        "token" in message
          ? (message.token as (AppToken & Record<string, unknown>) | null)?.sid
          : undefined;
      if (!sid) return;
      await db.authSession
        .updateMany({
          where: { id: sid, revokedAt: null },
          data: { revokedAt: new Date() },
        })
        .catch((error: unknown) =>
          console.error("Failed to end session on sign-out", error),
        );
    },
  },
  pages: {
    signIn: "/",
    error: "/auth/error",
  },
  trustHost: true,
} satisfies NextAuthConfig;
