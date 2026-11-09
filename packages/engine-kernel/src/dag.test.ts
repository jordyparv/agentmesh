import { describe, expect, it } from "vitest";
import { validateDag } from "./dag.ts";

describe("validateDag", () => {
  it("orders a valid DAG topologically", () => {
    const r = validateDag(["a", "b", "c", "d"], [{ from: "a", to: "b" }, { from: "a", to: "c" }, { from: "b", to: "d" }, { from: "c", to: "d" }]);
    expect(r).toEqual({ ok: true, order: ["a", "b", "c", "d"] });
  });
  it("rejects cycles and reports the cycle", () => {
    const r = validateDag(["a", "b", "c"], [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" }]);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error === "cycle") expect(r.cycle.length).toBeGreaterThanOrEqual(3);
  });
  it("rejects self dependencies and unknown nodes", () => {
    expect(validateDag(["a"], [{ from: "a", to: "a" }])).toMatchObject({ ok: false, error: "self_dependency" });
    expect(validateDag(["a"], [{ from: "x", to: "a" }])).toMatchObject({ ok: false, error: "unknown_node" });
  });
});
