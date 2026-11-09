/**
 * Browser tests of the Control Center against a real stack (API + worker + embedded
 * Postgres). Agent execution uses the SIMULATED "sim-*" adapters (real sandboxed processes,
 * scripted output); Claude/Codex/Antigravity are only probed here.
 */
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repo = mkdtempSync(path.join(tmpdir(), "agentmesh-e2e-repo-"));
const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@local", "-c", "commit.gpgsign=false", ...a], { cwd: repo, encoding: "utf8" }).trim();

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("sh", ["-c", "mkdir -p src && echo '# e2e' > README.md && echo 'export {};' > src/index.ts"], { cwd: repo });
  git("add", ".");
  git("commit", "-qm", "init");
});

test("dashboard renders live data", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByTestId("dashboard-metrics")).toContainText("Healthy agents");
  await expect(page.getByText("sim-coder").first()).toBeVisible();
});

test("register a repository through the portal", async ({ page }) => {
  await page.goto("/projects");
  await page.getByRole("button", { name: "Register repository" }).first().click();
  const form = page.getByRole("form", { name: "Register repository" });
  await form.getByLabel("Name").fill("E2E Demo");
  await form.getByLabel("Local repository path").fill("relative/path");
  await form.getByRole("button", { name: "Register" }).click();
  await expect(form.getByRole("alert")).toContainText("absolute");
  await form.getByLabel("Local repository path").fill(repo);
  await form.getByLabel("Validation commands (one per line)").fill("test -f src/greet.ts");
  await form.getByRole("button", { name: "Register" }).click();
  await expect(page.getByRole("link", { name: "E2E Demo" })).toBeVisible();
  await expect(page.locator("#project-select")).toHaveValue(/.+/);
  await page.getByRole("link", { name: "E2E Demo" }).click();
  await expect(page.getByText("Repository context")).toBeVisible();
  await expect(page.getByText("init")).toBeVisible();
});

test("agents show verified capabilities and integration modes", async ({ page }) => {
  await page.goto("/agents");
  const sim = page.getByTestId("agent-sim-coder");
  await expect(sim).toContainText("healthy");
  await expect(sim).toContainText("automated");
  await expect(sim).toContainText("implement");
  // Antigravity is never presented as automated unless verified.
  await expect(page.getByTestId("agent-Antigravity")).not.toContainText("automated");
  await sim.getByRole("button", { name: "Test connectivity" }).click();
  await expect(page.getByText(/sim-coder: healthy/)).toBeVisible();
});

test("create, assign and run a task with live status, then approve the merge (scenarios 13, 14)", async ({ page }) => {
  await page.goto("/tasks");
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
  await expect(page.getByText("live", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New task" }).click();
  const form = page.getByRole("form", { name: "Create task" });
  await form.getByLabel("Title").fill("Add greeting helper");
  await form.getByLabel("Requirements").fill("Create src/greet.ts exporting greet(name).");
  await form.getByLabel("Agent").selectOption({ label: "sim-coder (test)" });
  await form.getByLabel("Allowed paths (globs, one per line)").fill("src/**");
  await form.getByLabel("Start when dependencies are satisfied").check();
  await form.getByRole("button", { name: "Create task" }).click();

  const board = page.getByTestId("task-board");
  const card = board.locator("li", { hasText: "Add greeting helper" });
  await expect(card).toBeVisible();
  // Live updates via SSE: the card moves through Running into Review without reloads.
  await expect(board.locator('[data-column="running"]')).toContainText("Add greeting helper", { timeout: 20_000 });
  await expect(board.locator('[data-column="review"]')).toContainText("Add greeting helper", { timeout: 30_000 });

  await card.getByRole("link", { name: "Add greeting helper" }).click();
  await expect(page.getByTestId("task-status")).toContainText("awaiting approval");
  await expect(page.getByTestId("event-log")).toContainText("writing greet helper");
  await expect(page.getByTestId("event-log")).toContainText("knowledge.publish");
  await page.getByRole("tab", { name: "Changes" }).click();
  await expect(page.getByLabel("Diff")).toContainText("+export const greet");
  await page.getByRole("tab", { name: "Validation" }).click();
  await expect(page.getByTestId("validations")).toContainText("command:test -f src/greet.ts");
  await page.getByRole("tab", { name: "Context" }).click();
  await expect(page.getByTestId("context-rendered")).toContainText("## Task specification");
  await page.getByRole("tab", { name: "Knowledge" }).click();
  await expect(page.getByText("Greeting helper is not localized")).toBeVisible();

  // Review Center -> approve -> engine integrates into main.
  await page.goto("/reviews");
  await page.getByRole("link", { name: "Add greeting helper" }).click();
  await expect(page.getByTestId("requirements")).toContainText("Quality gates passed");
  await expect(page.getByTestId("requirements")).toContainText("Merges cleanly into main");
  expect(git("ls-tree", "-r", "--name-only", "main")).not.toContain("src/greet.ts");
  await page.getByRole("button", { name: "Approve & merge" }).click();
  await expect(page.getByText(/Integrated at [0-9a-f]{10}/)).toBeVisible();
  expect(git("ls-tree", "-r", "--name-only", "main")).toContain("src/greet.ts");
});

test("shared memory explorer shows provenance and supports verification", async ({ page }) => {
  await page.goto("/knowledge");
  await page.getByTestId("knowledge-list").getByText("Greeting helper is not localized").click();
  const detail = page.getByTestId("knowledge-detail");
  await expect(detail).toContainText("sim-coder");
  await expect(detail).toContainText("evidenced");
  await expect(detail).toContainText("not authoritative");
  await page.getByLabel("Action comment").fill("Confirmed: strings are hardcoded.");
  await detail.getByRole("button", { name: "Verify" }).click();
  await expect(detail).toContainText("verified");
  await expect(detail.getByText("authoritative", { exact: true })).toBeVisible();
});

test("cancel and retry from the board (scenario 15)", async ({ page }) => {
  await page.goto("/tasks");
  await page.getByRole("button", { name: "New task" }).click();
  const form = page.getByRole("form", { name: "Create task" });
  await form.getByLabel("Title").fill("Long job");
  await form.getByLabel("Requirements").fill("TEST_SCRIPT_KEY: slow");
  await form.getByLabel("Agent").selectOption({ label: "sim-coder (test)" });
  await form.getByLabel("Start when dependencies are satisfied").check();
  await form.getByRole("button", { name: "Create task" }).click();
  const board = page.getByTestId("task-board");
  await expect(board.locator('[data-column="running"]')).toContainText("Long job", { timeout: 20_000 });
  await board.getByRole("button", { name: "cancel Long job" }).click();
  await expect(board.locator('[data-column="failed"]')).toContainText("Long job");
  await board.getByRole("button", { name: "retry Long job" }).click();
  await expect(board.locator('[data-column="running"]')).toContainText("Long job", { timeout: 20_000 });
  await board.getByRole("button", { name: "cancel Long job" }).click();
  await expect(board.locator('[data-column="failed"]')).toContainText("Long job");
});

test("workflow builder loads an executable template", async ({ page }) => {
  await page.goto("/workflows");
  await page.getByRole("link", { name: /^Engineering/ }).click();
  await expect(page.getByTestId("wf-validity")).toContainText("executable");
  await expect(page.locator(".react-flow__node")).toHaveCount(8);
  await expect(page.getByText("template (read-only)")).toBeVisible();
});

test("theme toggle switches to dark mode", async ({ page }) => {
  await page.goto("/");
  const html = page.locator("html");
  const wasDark = (await html.getAttribute("class"))?.includes("dark") ?? false;
  await page.getByRole("button", { name: wasDark ? "Switch to light theme" : "Switch to dark theme" }).click();
  if (wasDark) await expect(html).not.toHaveClass(/dark/);
  else await expect(html).toHaveClass(/dark/);
});
