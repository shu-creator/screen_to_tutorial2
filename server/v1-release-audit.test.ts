import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { checkV1Smoke, shouldExitWithFailure, topLevelStatus } from "../scripts/v1-release-audit";

describe("v1 release audit", () => {
  it("--allow-incomplete does not suppress fail checks", () => {
    const incompleteOnly = {
      pass: false,
      checks: [{ name: "fresh", status: "incomplete" as const, detail: "missing" }],
    };
    const withFailure = {
      pass: false,
      checks: [
        { name: "fresh", status: "incomplete" as const, detail: "missing" },
        { name: "model", status: "fail" as const, detail: "wrong model" },
      ],
    };

    expect(shouldExitWithFailure(incompleteOnly, true)).toBe(false);
    expect(shouldExitWithFailure(incompleteOnly, false)).toBe(true);
    expect(shouldExitWithFailure(withFailure, true)).toBe(true);
    expect(topLevelStatus(withFailure.checks)).toBe("fail");
  });

  it("fails a smoke summary that omits required artifact paths", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "v1-release-audit-"));
    const summaryPath = path.join(tempDir, "v1_smoke_summary.json");
    await fs.writeFile(summaryPath, JSON.stringify({
      pass: true,
      project_id: 1,
      metrics: { step_count: 1, fallback_reason_count: 0 },
      checks: [{ name: "setup.check", pass: true }],
    }));

    const result = await checkV1Smoke(summaryPath, "smoke.test", false);

    expect(result.status).toBe("fail");
    expect(result.detail).toContain("missing artifact fields");
  });

  it("returns fail instead of throwing for malformed smoke summary JSON", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "v1-release-audit-"));
    const summaryPath = path.join(tempDir, "v1_smoke_summary.json");
    await fs.writeFile(summaryPath, "{ not valid json }");

    const result = await checkV1Smoke(summaryPath, "smoke.test", false);

    expect(result.status).toBe("fail");
    expect(result.detail).toContain("could not parse JSON");
  });

  it("can treat a missing current smoke summary as fail", async () => {
    const result = await checkV1Smoke(path.join(os.tmpdir(), "missing-v1-smoke-summary.json"), "smoke.test", false, "fail");

    expect(result.status).toBe("fail");
    expect(result.detail).toContain("missing summary");
  });
});
