/**
 * A "principal" is whoever signs in: a User (staff/student) or a ParentGuardian.
 * Security data is keyed by principal id + type so both kinds get the same features.
 */
import type { PrincipalType } from "@prisma/client";
import { db } from "~/server/db";

export type Principal = { id: string; type: PrincipalType };

export type PrincipalAccount = Principal & {
  role: string;
  /** User.accountId (registration/employee number) or the parent id. */
  accountId: string;
  /** Identifier typed at sign-in (email for users, username for parents). */
  loginId: string;
  displayName: string;
  email: string | null;
  passwordHash: string;
  isActive: boolean;
  tokenVersion: number;
  mustChangePassword: boolean;
  /** Phone on the linked record, offered as a default for SMS. */
  suggestedPhone: string | null;
};

export function principalFromSession(user: {
  id: string;
  accountType?: string | null;
}): Principal {
  return {
    id: user.id,
    type:
      (user.accountType ?? "").toUpperCase() === "PARENT" ? "PARENT" : "USER",
  };
}

export async function loadAccount(
  principal: Principal,
): Promise<PrincipalAccount | null> {
  if (principal.type === "PARENT") {
    const parent = await db.parentGuardian.findUnique({
      where: { guardentId: principal.id },
    });
    if (!parent) return null;
    return {
      ...principal,
      role: "PARENT",
      accountId: parent.guardentId,
      loginId: parent.username,
      displayName: parent.username,
      email: null,
      passwordHash: parent.passwordHash,
      isActive: parent.isActive,
      tokenVersion: parent.tokenVersion,
      mustChangePassword: parent.mustChangePassword,
      suggestedPhone: parent.mobileNumber || null,
    };
  }
  const user = await db.user.findUnique({ where: { id: principal.id } });
  if (!user) return null;
  return {
    ...principal,
    role: user.accountType,
    accountId: user.accountId,
    loginId: user.email,
    displayName: user.username,
    email: user.email,
    passwordHash: user.password,
    isActive: user.isActive,
    tokenVersion: user.tokenVersion,
    mustChangePassword: user.mustChangePassword,
    suggestedPhone: null,
  };
}

/** Invalidate every JWT for this principal (they re-authenticate on next revalidation). */
export async function bumpTokenVersion(principal: Principal) {
  if (principal.type === "PARENT") {
    await db.parentGuardian.update({
      where: { guardentId: principal.id },
      data: { tokenVersion: { increment: 1 } },
    });
  } else {
    await db.user.update({
      where: { id: principal.id },
      data: { tokenVersion: { increment: 1 } },
    });
  }
}
