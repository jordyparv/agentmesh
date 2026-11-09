import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { DomainError, forbidden, type Role } from "@agentmesh/contracts";
import { apiTokens, type Db } from "@agentmesh/database";

export interface Principal {
  tokenId: string;
  name: string;
  role: Role;
  /** null = all projects */
  projectIds: string[] | null;
  /** Actor string recorded in audit logs. */
  actor: string;
}

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal;
  }
}

const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };
export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

/** Creates an API token. The plaintext is returned once and only its hash is stored. */
export async function createApiToken(db: Db, opts: { name: string; role: Role; projectIds?: string[] | null; /** fixtures only */ token?: string }): Promise<{ id: string; token: string }> {
  const token = opts.token ?? `am_${randomBytes(24).toString("hex")}`;
  if (!/^am_[a-f0-9]{48}$/.test(token)) throw new Error("invalid token format");
  const [row] = await db.insert(apiTokens).values({ name: opts.name, role: opts.role, projectIds: opts.projectIds ?? null, tokenHash: hashToken(token) }).returning({ id: apiTokens.id });
  return { id: row!.id, token };
}

export function authenticate(db: Db) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const header = req.headers.authorization ?? "";
    const m = /^Bearer\s+(am_[a-f0-9]{48})$/.exec(header);
    if (!m) throw new DomainError("UNAUTHENTICATED", "Missing or malformed bearer token", 401);
    const h = hashToken(m[1]!);
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.tokenHash, h));
    if (!row || row.revokedAt || !timingSafeEqual(Buffer.from(row.tokenHash), Buffer.from(h))) throw new DomainError("UNAUTHENTICATED", "Invalid or revoked token", 401);
    req.principal = { tokenId: row.id, name: row.name, role: row.role, projectIds: row.projectIds ?? null, actor: `user:${row.name}` };
    if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
      await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.id));
    }
  };
}

export function requireRole(req: FastifyRequest, role: Role): void {
  if (RANK[req.principal.role] < RANK[role]) throw forbidden(`Requires ${role} role`);
}

export function assertProjectAccess(req: FastifyRequest, projectId: string): void {
  const scope = req.principal.projectIds;
  if (scope && !scope.includes(projectId)) throw forbidden("Token is not authorized for this project");
}

export function projectScope(req: FastifyRequest): string[] | null {
  return req.principal.projectIds;
}
