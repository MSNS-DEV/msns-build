import { type DefaultSession, type NextAuthConfig } from "next-auth";
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

/** How often an active session is re-checked against the database. */
const REVALIDATE_MS = 5 * 60 * 1000;

/**
 * bcrypt hash of a random value, compared against when the account doesn't
 * exist so that response time doesn't reveal which emails are registered.
 */
const DUMMY_HASH =
  "$2b$10$L3yLEiqImnCQ3/e0kmwTbu0PYY0vpQJtNr8d.lO1HpLJLpvgxvZw.";

declare module "next-auth" {
  interface Session extends DefaultSession {
    user: {
      id: string;
      email: string;
      username: string;
      accountId: string;
      accountType: string;
      mustChangePassword: boolean;
    } & DefaultSession["user"];
  }

  interface User {
    username: string;
    accountId: string;
    accountType: string;
    mustChangePassword?: boolean;
    tokenVersion?: number;
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
};

/**
 * Re-read the account behind a session token. Returns null when the account
 * was removed, deactivated or had its sessions revoked (tokenVersion bump).
 */
async function revalidateToken<T extends AppToken>(
  token: T,
): Promise<T | null> {
  if (!token.id) return null;
  if (token.accountType === "PARENT") {
    const parent = await db.parentGuardian.findUnique({
      where: { guardentId: token.id },
      select: { isActive: true, username: true },
    });
    if (!parent?.isActive) return null;
    return { ...token, username: parent.username, checkedAt: Date.now() };
  }
  const user = await db.user.findUnique({
    where: { id: token.id },
    select: {
      accountId: true,
      accountType: true,
      username: true,
      email: true,
      mustChangePassword: true,
      tokenVersion: true,
    },
  });
  if (!user) return null;
  if ((token.tokenVersion ?? 0) !== user.tokenVersion) return null;
  if (user.accountType === "STUDENT") {
    // Student records can be deleted while the User row remains.
    const student = await db.students.findUnique({
      where: { registrationNumber: user.accountId },
      select: { studentId: true },
    });
    if (!student) return null;
  }
  return {
    ...token,
    accountId: user.accountId,
    accountType: user.accountType,
    username: user.username,
    email: user.email,
    mustChangePassword: user.mustChangePassword,
    checkedAt: Date.now(),
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
        try {
          if (await isLocked(keys)) {
            // Too many failures: refuse without checking the password.
            return null;
          }

          if (email.includes("@")) {
            const account = await db.user.findUnique({
              where: { email: email.trim().toLowerCase() },
            });
            const isValidPassword = await compare(
              password,
              account?.password ?? DUMMY_HASH,
            );
            if (!account || !isValidPassword) {
              await recordFailedLogin(email, ip);
              return null;
            }
            await clearFailedLogins(email);
            return {
              id: account.id,
              email: account.email,
              username: account.username,
              accountId: account.accountId,
              accountType: account.accountType,
              mustChangePassword: account.mustChangePassword,
              tokenVersion: account.tokenVersion,
            };
          }

          const parent = await db.parentGuardian.findUnique({
            where: { username: email },
          });
          const isValidPassword = await compare(
            password,
            parent?.passwordHash ?? DUMMY_HASH,
          );
          if (!parent?.isActive || !isValidPassword) {
            await recordFailedLogin(email, ip);
            return null;
          }
          await clearFailedLogins(email);
          return {
            id: parent.guardentId,
            email: "",
            username: parent.username,
            accountId: parent.guardentId,
            accountType: "PARENT",
            mustChangePassword: false,
            tokenVersion: 0,
          };
        } catch (error) {
          console.error("Auth error:", error);
          return null;
        }
      },
    }),
  ],
  callbacks: {
    async session({ session, token }) {
      return {
        ...session,
        user: {
          ...session.user,
          id: token.id as string,
          email: token.email!,
          accountType: token.accountType as string,
          accountId: token.accountId as string,
          username: token.username as string,
          mustChangePassword: Boolean(token.mustChangePassword),
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
          checkedAt: Date.now(),
        };
      }
      const t = token as typeof token & AppToken;
      const stale =
        trigger === "update" ||
        t.mustChangePassword === true ||
        !t.checkedAt ||
        Date.now() - t.checkedAt > REVALIDATE_MS;
      if (!stale) return token;
      try {
        return await revalidateToken(t);
      } catch (error) {
        // Database unreachable: keep the session rather than logging everyone out.
        console.error("Session revalidation failed:", error);
        return token;
      }
    },
  },
  pages: {
    signIn: "/",
    error: "/auth/error",
  },
  trustHost: true,
} satisfies NextAuthConfig;
