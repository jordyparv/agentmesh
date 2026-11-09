/**
 * Sensitive-value redaction applied to every log line, agent event and artifact the
 * engine persists. Pattern-based plus exact values of secrets the worker knows about.
 */
const PATTERNS: RegExp[] = [
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g, // OpenAI / Anthropic style keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bam_[a-f0-9]{48}\b/g, // AgentMesh API tokens
  /(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/g, // passwords in connection strings
];

export class Redactor {
  private secrets: string[] = [];

  addSecret(value: string | undefined): void {
    if (value && value.length >= 6 && !this.secrets.includes(value)) this.secrets.push(value);
  }

  redact(input: string): string {
    let out = input;
    for (const s of this.secrets) out = out.split(s).join("[REDACTED]");
    for (const p of PATTERNS) {
      out = out.replace(p, (m, prefix?: string) => (typeof prefix === "string" && m.startsWith(prefix) ? `${prefix}[REDACTED]` : "[REDACTED]"));
    }
    return out;
  }

  redactDeep<T>(value: T): T {
    if (typeof value === "string") return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.redactDeep(v)) as T;
    if (value && typeof value === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        o[k] = /(?:secret|password|token|api[_-]?key|authorization)/i.test(k) && typeof v === "string" ? "[REDACTED]" : this.redactDeep(v);
      }
      return o as T;
    }
    return value;
  }
}

export const defaultRedactor = new Redactor();
