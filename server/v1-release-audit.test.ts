import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { assertSafeOutdir, buildChildEnv } from "../scripts/v1-fresh-env-smoke";
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

  it("requires fresh checkout metadata for fresh-env smoke evidence", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "v1-release-audit-"));
    const stepsPath = path.join(tempDir, "steps.json");
    const exportPath = path.join(tempDir, "export.json");
    const editPath = path.join(tempDir, "edit.json");
    const summaryPath = path.join(tempDir, "v1_smoke_summary.json");
    await fs.writeFile(stepsPath, "{}");
    await fs.writeFile(exportPath, "{}");
    await fs.writeFile(editPath, "{}");
    await fs.writeFile(summaryPath, JSON.stringify({
      pass: true,
      project_id: 1,
      options: { ocr_provider: "none" },
      artifacts: {
        steps: stepsPath,
        export_summary: exportPath,
        edit_smoke_summary: editPath,
      },
      metrics: { step_count: 1, fallback_reason_count: 0 },
      checks: [{ name: "setup.check", pass: true }],
    }));

    const result = await checkV1Smoke(summaryPath, "smoke.fresh", true);

    expect(result.status).toBe("fail");
    expect(result.detail).toContain("environment.kind=fresh_checkout");
  });

  it("passes fresh-env smoke evidence with complete metadata", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "v1-release-audit-"));
    const stepsPath = path.join(tempDir, "steps.json");
    const exportPath = path.join(tempDir, "export.json");
    const editPath = path.join(tempDir, "edit.json");
    const summaryPath = path.join(tempDir, "v1_smoke_summary.json");
    await fs.writeFile(stepsPath, "{}");
    await fs.writeFile(exportPath, "{}");
    await fs.writeFile(editPath, "{}");
    await fs.writeFile(summaryPath, JSON.stringify({
      pass: true,
      project_id: 1,
      options: { ocr_provider: "none" },
      artifacts: {
        steps: stepsPath,
        export_summary: exportPath,
        edit_smoke_summary: editPath,
      },
      metrics: { step_count: 1, fallback_reason_count: 0 },
      checks: [{ name: "setup.check", pass: true }],
      environment: {
        kind: "fresh_checkout",
        source_commit: "abc1234def5678",
        dependency_install: { command: "pnpm install --frozen-lockfile --offline" },
      },
    }));

    const result = await checkV1Smoke(summaryPath, "smoke.fresh", true);

    expect(result.status).toBe("pass");
  });

  it("rejects the outputs root as a fresh-env smoke outdir", () => {
    expect(() => assertSafeOutdir(path.join(process.cwd(), "outputs"))).toThrow("--outdir must be within");
    expect(() => assertSafeOutdir(os.tmpdir())).toThrow("--outdir must be within");
    expect(() => assertSafeOutdir(path.join(process.cwd(), "outputs", "v1-fresh-env-smoke"))).not.toThrow();
  });

  it("does not pass DATABASE_URL or arbitrary parent secrets to child commands", () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    const originalInternalSecret = process.env.SOME_INTERNAL_SECRET;
    process.env.DATABASE_URL = "mysql://user:password@example.local/db";
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.SOME_INTERNAL_SECRET = "do-not-forward";

    try {
      const env = buildChildEnv();

      expect(env.DATABASE_URL).toBeUndefined();
      expect(env.SOME_INTERNAL_SECRET).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBe("test-openai-key");
      expect(env.PATH).toBeDefined();
      expect(env.HOME).toBeDefined();
      expect(env.NODE_ENV).toBe("development");
    } finally {
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
      if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAiKey;
      if (originalInternalSecret === undefined) delete process.env.SOME_INTERNAL_SECRET;
      else process.env.SOME_INTERNAL_SECRET = originalInternalSecret;
    }
  });
});
