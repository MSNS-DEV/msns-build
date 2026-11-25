import type { Prisma } from "@prisma/client";
import { db } from "~/server/db";
import type { Principal } from "./principal";

export type RequestMeta = { ip: string | null; userAgent: string | null };

export function metaFromHeaders(headers: Headers | undefined): RequestMeta {
  const fwd = headers?.get("x-forwarded-for");
  return {
    ip: fwd?.split(",")[0]?.trim() ?? headers?.get("x-real-ip") ?? null,
    userAgent: headers?.get("user-agent")?.slice(0, 300) ?? null,
  };
}

/** Never put codes, secrets or passwords in `detail`. */
export async function logSecurityEvent(
  principal: Principal,
  type: string,
  meta?: RequestMeta,
  detail?: Prisma.InputJsonValue,
) {
  try {
    await db.securityEvent.create({
      data: {
        principalId: principal.id,
        principalType: principal.type,
        type,
        detail,
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
      },
    });
  } catch (error) {
    // Auditing must not break sign-in.
    console.error("Failed to record security event", type, error);
  }
}

export async function logAdminAction(input: {
  actor: { id: string; role: string; name?: string | null };
  target?: { id: string; type: string; name?: string | null };
  action: string;
  detail?: Prisma.InputJsonValue;
  ip?: string | null;
}) {
  await db.adminAuditLog.create({
    data: {
      actorId: input.actor.id,
      actorRole: input.actor.role,
      actorName: input.actor.name ?? null,
      targetId: input.target?.id ?? null,
      targetType: input.target?.type ?? null,
      targetName: input.target?.name ?? null,
      action: input.action,
      detail: input.detail,
      ip: input.ip ?? null,
    },
  });
}
