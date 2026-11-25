import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

/**
 * Security headers + server-side route protection for the dashboards.
 *
 * Page routes under the role prefixes below require a session whose role is
 * allowed for that prefix. API routes and tRPC procedures do their own checks;
 * this guard only stops the dashboard UIs from being served to the wrong users.
 */

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
};

const OFFICE = ["ADMIN", "PRINCIPAL", "HEAD", "CLERK"];

/** Dashboard prefix → roles allowed to load pages under it. */
const ROUTE_ROLES: [prefix: string, roles: string[] | "any"][] = [
  // HEAD/PRINCIPAL/CLERK navigate into /admin/* pages from their sidebars.
  ["/admin", OFFICE],
  ["/clerk", OFFICE],
  ["/principal", ["PRINCIPAL", "ADMIN"]],
  ["/head", ["HEAD", "ADMIN"]],
  ["/teacher", ["TEACHER", "ADMIN"]],
  ["/student", ["STUDENT", "ADMIN"]],
  ["/worker", ["WORKER", "ADMIN"]],
  ["/parent", ["PARENT"]],
  ["/documents", "any"],
];

/** Where each role lands (mirrors RedirectMap in src/constants). */
const HOME_BY_ROLE: Record<string, string> = {
  PRINCIPAL: "/principal",
  ADMIN: "/admin",
  HEAD: "/head",
  CLERK: "/clerk",
  TEACHER: "/teacher",
  WORKER: "/worker",
  STUDENT: "/student",
  PARENT: "/parent/dashboard",
};

function matchRoute(pathname: string) {
  return ROUTE_ROLES.find(
    ([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function withHeaders(response: NextResponse) {
  for (const [key, value] of Object.entries(securityHeaders)) {
    response.headers.set(key, value);
  }
  return response;
}

export async function middleware(request: NextRequest) {
  const route = matchRoute(request.nextUrl.pathname);
  if (!route) return withHeaders(NextResponse.next());

  // Auth.js uses the __Secure- cookie name whenever AUTH_URL/the site is https.
  const secureCookie =
    request.cookies.has("__Secure-authjs.session-token") ||
    request.nextUrl.protocol === "https:";
  const token = await getToken({
    req: request,
    secret: process.env.AUTH_SECRET,
    secureCookie,
  });

  if (!token) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = "";
    return withHeaders(NextResponse.redirect(url));
  }

  const role =
    typeof token.accountType === "string" ? token.accountType.toUpperCase() : "";
  const allowed = route[1];
  if (allowed !== "any" && !allowed.includes(role)) {
    const url = request.nextUrl.clone();
    url.pathname = HOME_BY_ROLE[role] ?? "/sign-in";
    url.search = "";
    return withHeaders(NextResponse.redirect(url));
  }

  return withHeaders(NextResponse.next());
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
