import path from "path";
import { describe, expect, it } from "vitest";
import {
  buildPromptCheckPlan,
  formatPlan,
  parseArgs,
  repoRoot,
  validateExecutionOptions,
} from "../scripts/post-v1-prompt-check";

describe("post-v1 prompt check helper", () => {
  it("prints a no-write plan by default for the low-G2 case", () => {
    const options = parseArgs(["--", "--run-id", "test-run"]);
    const plan = buildPromptCheckPlan(options);
    const text = formatPlan(plan, options.execute);

    expect(options.execute).toBe(false);
    expect(plan.caseId).toBe("real-app-workflow-03-generate-steps");
    expect(plan.outdir).toBe(path.join(repoRoot, "outputs", "post-v1-prompt-check", "real-app-workflow-03-generate-steps-run-test-run"));
    expect(plan.preflightCommand).toContain("--preflight");
    expect(plan.executeCommand).not.toContain("--preflight");
    expect(plan.evalStepsPathTemplate).toContain("project_<project-id>_steps.json");
    expect(plan.evalCommandTemplate).toContain("--post-v1-promotion-gate");
    expect(plan.evalCommandTemplate).toContain("project_<project-id>_steps.json");
    expect(plan.evalCommandTemplate).not.toContain("project_*_steps.json");
    expect(text).toContain("Post-v1 prompt check: plan only (no writes)");
    expect(text).toContain("create or update CLI user/project state");
    expect(text).toContain("replace <project-id> with the actual generated project id");
  });

  it("keeps optional pipeline args aligned between preflight and execute commands", () => {
    const options = parseArgs([
      "--run-id",
      "test-run",
      "--ocr-provider",
      "none",
      "--threshold",
      "5",
      "--min-interval",
      "30",
      "--max-frames",
      "12",
    ]);
    const plan = buildPromptCheckPlan(options);
    const preflightWithoutFlag = plan.preflightCommand.filter((arg) => arg !== "--preflight");

    expect(preflightWithoutFlag).toEqual(plan.executeCommand);
    expect(plan.executeCommand).toContain("--ocr-provider");
    expect(plan.executeCommand).toContain("none");
    expect(plan.executeCommand).toContain("--threshold");
    expect(plan.executeCommand).toContain("5");
    expect(plan.executeCommand).toContain("--min-interval");
    expect(plan.executeCommand).toContain("30");
    expect(plan.executeCommand).toContain("--max-frames");
    expect(plan.executeCommand).toContain("12");
  });

  it("requires explicit side-effect acceptance before execute mode", () => {
    const options = parseArgs(["--execute", "--run-id", "test-run"]);

    expect(() => validateExecutionOptions(options)).toThrow("--execute requires --accept-side-effects");

    const accepted = parseArgs(["--execute", "--accept-side-effects", "--run-id", "test-run"]);
    expect(() => validateExecutionOptions(accepted)).not.toThrow();

    const acceptOnly = parseArgs(["--accept-side-effects", "--run-id", "test-run"]);
    expect(() => validateExecutionOptions(acceptOnly)).toThrow("--accept-side-effects requires --execute");
  });

  it("rejects path traversal case ids", () => {
    expect(() => parseArgs(["--case", "../escape"])).toThrow("must not contain path separators");
    expect(() => parseArgs(["--case", ".."])).toThrow("must not be a directory reference");
  });
});
