/**
 * Decides what a fresh sign-in still needs: a second factor, or 2FA enrolment
 * because the account's role requires it.
 */
import {
  getMethods,
  getSecurityRow,
  hasSecondFactor,
  roleRequires2fa,
} from "./mfa";
import type { PrincipalAccount } from "./principal";
import {
  readCookie,
  trustedDeviceCookieName,
  verifyTrustedDeviceCookie,
} from "./sessions";

export type SignInState = {
  mfaPending: boolean;
  enrollRequired: boolean;
};

export async function signInState(
  account: PrincipalAccount,
  cookieHeader: string | null | undefined,
): Promise<SignInState> {
  const [methods, sec, policy] = await Promise.all([
    getMethods(account),
    getSecurityRow(account),
    roleRequires2fa(account.role),
  ]);
  if (!hasSecondFactor(methods)) {
    return { mfaPending: false, enrollRequired: policy };
  }
  const trusted = verifyTrustedDeviceCookie(
    readCookie(cookieHeader, trustedDeviceCookieName(account.id)),
    account.id,
    account.tokenVersion,
    sec?.deviceTrustVersion ?? 0,
  );
  return { mfaPending: !trusted, enrollRequired: false };
}

/** For revalidation of an existing session: is enrolment (still) required? */
export async function enrollmentRequired(account: PrincipalAccount) {
  if (!(await roleRequires2fa(account.role))) return false;
  return !hasSecondFactor(await getMethods(account));
}
