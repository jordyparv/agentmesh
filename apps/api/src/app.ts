import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import { hasZodFastifySchemaValidationErrors, jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { ZodError } from "zod";
import { DomainError, InvalidTransitionError } from "@agentmesh/contracts";
import type { Engine } from "@agentmesh/engine-kernel";
import { authenticate } from "./auth.ts";
import { projectRoutes } from "./routes/projects.ts";
import { agentRoutes } from "./routes/agents.ts";
import { taskRoutes } from "./routes/tasks.ts";
import { reviewRoutes } from "./routes/reviews.ts";
import { eventRoutes } from "./routes/events.ts";
import { statsRoutes } from "./routes/stats.ts";
import { knowledgeRoutes } from "./routes/knowledge.ts";
import { workflowRoutes } from "./routes/workflows.ts";
import { agentToolRoutes } from "./routes/agent-tools.ts";

export interface AppOptions {
  engine: Engine;
  /** Restrict repository registration to these roots (recommended). */
  allowedRepoRoots?: string[];
  logger?: boolean | object;
  rateLimitPerMinute?: number;
  ssePollMs?: number;
}

export type App = FastifyInstance;

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1024 * 1024, trustProxy: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, {
    openapi: {
      info: { title: "AgentMesh API", version: "1.0.0" },
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
      security: [{ bearer: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(rateLimit, { max: opts.rateLimitPerMinute ?? 600, timeWindow: "1 minute" });

  app.setErrorHandler((err, _req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: err.validation } });
    }
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Validation failed", details: err.issues } });
    if (err instanceof InvalidTransitionError) return reply.code(409).send({ error: { code: err.code, message: err.message } });
    if (err instanceof DomainError) return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: { code: (err as { code?: string }).code ?? "BAD_REQUEST", message: (err as Error).message } });
    app.log.error(err);
    return reply.code(500).send({ error: { code: "INTERNAL", message: "Internal server error" } });
  });

  app.get("/api/v1/health", { schema: { hide: true } }, async () => ({ ok: true }));
  app.get("/api/v1/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  await app.register(async (secured) => {
    secured.addHook("onRequest", authenticate(opts.engine.db));
    await secured.register(projectRoutes, { engine: opts.engine, allowedRepoRoots: opts.allowedRepoRoots });
    await secured.register(agentRoutes, { engine: opts.engine });
    await secured.register(taskRoutes, { engine: opts.engine });
    await secured.register(reviewRoutes, { engine: opts.engine });
    await secured.register(eventRoutes, { engine: opts.engine, pollMs: opts.ssePollMs ?? 500 });
    await secured.register(statsRoutes, { engine: opts.engine });
    await secured.register(knowledgeRoutes, { engine: opts.engine });
    await secured.register(workflowRoutes, { engine: opts.engine });
  });
  // Separate auth realm: run-scoped agent tokens only.
  await app.register(agentToolRoutes, { engine: opts.engine });
  return app;
}

export { createApiToken } from "./auth.ts";
