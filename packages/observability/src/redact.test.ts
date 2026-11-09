import { describe, expect, it } from "vitest";
import { Redactor } from "./redact.ts";

describe("Redactor", () => {
  it("redacts known secret formats and registered values", () => {
    const r = new Redactor();
    r.addSecret("super-secret-value-123");
    const out = r.redact("key sk-proj-abcdefghijklmnopqrstuvwx and ghp_abcdefghijklmnopqrstuvwxyz0123 Bearer abcdefghijklmnopqrstuv and super-secret-value-123 postgres://u:pw@h/db");
    expect(out).not.toMatch(/sk-proj-abc|ghp_abc|super-secret|:pw@/);
    expect(out).toContain("Bearer [REDACTED]");
  });
  it("redacts secret-named keys deeply", () => {
    expect(new Redactor().redactDeep({ a: { apiKey: "x", token: "y", ok: "z" } })).toEqual({ a: { apiKey: "[REDACTED]", token: "[REDACTED]", ok: "z" } });
  });
});
