import pino, { type Logger } from "pino";
import { defaultRedactor } from "./redact.ts";

export type { Logger };

export function createLogger(name: string, level = process.env.LOG_LEVEL ?? "info"): Logger {
  return pino({
    name,
    level,
    redact: { paths: ["*.authorization", "*.token", "*.password", "req.headers.authorization", "req.headers.cookie"], censor: "[REDACTED]" },
    hooks: {
      logMethod(args, method) {
        method.apply(this, args.map((a) => (typeof a === "string" ? defaultRedactor.redact(a) : a)) as Parameters<typeof method>);
      },
    },
  });
}
