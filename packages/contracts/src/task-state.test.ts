import { describe, expect, it } from "vitest";
import { canTransition, TASK_STATUSES } from "./task-state.ts";

describe("task state machine", () => {
  it("allows the happy path", () => {
    const path = ["PENDING", "READY", "LEASED", "RUNNING", "VALIDATING", "COMPLETED"] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
  });
  it("rejects illegal transitions", () => {
    expect(canTransition("PENDING", "RUNNING")).toBe(false);
    expect(canTransition("READY", "COMPLETED")).toBe(false);
    expect(canTransition("RUNNING", "COMPLETED")).toBe(false); // must pass validation
    expect(canTransition("LEASED", "COMPLETED")).toBe(false);
    expect(canTransition("FAILED", "COMPLETED")).toBe(false);
  });
  it("COMPLETED is terminal", () => {
    for (const s of TASK_STATUSES) expect(canTransition("COMPLETED", s)).toBe(false);
  });
});
