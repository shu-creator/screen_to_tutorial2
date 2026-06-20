import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import type { CaseMeta, G4Record } from "../scripts/eval-audit";
import type { QualityGateResult } from "../scripts/eval-quality-gate";
import { assertSafeOutdir, assessFreshEnvPreflight, buildChildEnv } from "../scripts/v1-fresh-env-smoke";
import {
  assessHumanG4,
  assessQualityGate,
  assessQualityGateError,
  buildReleaseCheckTasks,
  checkQualityGate,
  checkV1Smoke,
  shouldExitWithFailure,
  topLevelStatus,
} from "../scripts/v1-release-audit";

const validCounts = {
  title_edits: 0,
  description_edits: 0,
  narration_edits: 0,
  timing_edits: 0,
  citation_edits: 0,
  step_structure_edits: 0,
  export_artifact_edits: 0,
  other_edits: 0,
};

function humanG4(caseId: string, overrides: Partial<G4Record> = {}): G4Record {
  return {
    case_id: caseId,
    review_type: "human_review",
    reviewer: "human-reviewer",
    reviewed_at: "2026-06-20",
    source_artifact: `eval/results/generated/${caseId}/steps.json`,
    counts: validCounts,
    total_manual_edits: 0,
    ...overrides,
  };
}

function qualityGateResult(overrides: Partial<QualityGateResult> = {}): QualityGateResult {
  return {
    pass: true,
    realCaseCount: 5,
    g2Average: 0.694,
    baselineG2Average: 0.694,
    g3Average: 0.07,
    baselineG3Average: 0.07,
    results: [],
    notes: [],
    ...overrides,
  };
}

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

  it("reports the Sprint 2 quality gate as a release-audit check", () => {
    const passed = assessQualityGate(qualityGateResult());
    expect(passed).toEqual({
      name: "eval.quality_gate",
      status: "pass",
      detail: "real_cases=5; G2=69.4%; G3=7.0%",
    });

    const failed = assessQualityGate(qualityGateResult({
      pass: false,
      notes: ["real-app-workflow-03-generate-steps: g2_regression"],
    }));
    expect(failed).toEqual({
      name: "eval.quality_gate",
      status: "fail",
      detail: "real_cases=5; G2=69.4%; G3=7.0%; real-app-workflow-03-generate-steps: g2_regression",
    });
  });

  it("keeps the Sprint 2 quality gate wired into the release-audit task order", () => {
    const tasks = buildReleaseCheckTasks({
      json: false,
      allowIncomplete: false,
      v1SmokeSummary: "outputs/current.json",
      freshEnvSummary: "outputs/fresh.json",
    });

    expect(tasks.map((task) => task.name)).toEqual([
      "release.docs",
      "model.default",
      "eval.readiness",
      "eval.quality_gate",
      "smoke.current_environment",
      "export.qa",
      "g4.human_review",
      "smoke.fresh_environment",
    ]);
  });

  it("turns quality-gate runtime errors into release-audit failures", async () => {
    const result = await checkQualityGate(async () => {
      throw new Error("missing baseline.json");
    });

    expect(result).toEqual({
      name: "eval.quality_gate",
      status: "fail",
      detail: "runQualityGate threw: missing baseline.json",
    });
  });

  it("formats quality-gate errors consistently", () => {
    expect(assessQualityGateError("missing baseline.json")).toEqual({
      name: "eval.quality_gate",
      status: "fail",
      detail: "runQualityGate threw: missing baseline.json",
    });
  });

  it("rejects non-human, synthetic, and unrelated G4 records as release evidence", async () => {
    const caseMetas: CaseMeta[] = [
      { case_id: "real-01", synthetic: false },
      { case_id: "real-02", synthetic: false },
      { case_id: "real-03" },
      { case_id: "synthetic-01", synthetic: true },
    ];

    const incomplete = await assessHumanG4(caseMetas, [
      humanG4("real-01", { review_type: "ai_estimate" }),
      humanG4("synthetic-01"),
      humanG4("real-03"),
      humanG4("unrelated-real-case"),
    ]);
    expect(incomplete.status).toBe("incomplete");
    expect(incomplete.detail).toContain("0/2");
  });

  it("excludes invalid human_review G4 records from the release count", async () => {
    const caseMetas: CaseMeta[] = [
      { case_id: "real-01", synthetic: false },
      { case_id: "real-02", synthetic: false },
    ];

    const invalidRecord = await assessHumanG4(caseMetas, [
      humanG4("real-01"),
      humanG4("real-02", { total_manual_edits: 1 }),
    ]);
    expect(invalidRecord.status).toBe("incomplete");
    expect(invalidRecord.detail).toContain("1/2");
  });

  it("deduplicates human_review G4 records by case id", async () => {
    const caseMetas: CaseMeta[] = [
      { case_id: "real-01", synthetic: false },
      { case_id: "real-02", synthetic: false },
    ];

    const duplicateOnly = await assessHumanG4(caseMetas, [
      humanG4("real-01"),
      humanG4("real-01"),
    ]);
    expect(duplicateOnly.status).toBe("incomplete");
    expect(duplicateOnly.detail).toContain("1/2");
  });

  it("passes with two valid human_review records for required real cases", async () => {
    const caseMetas: CaseMeta[] = [
      { case_id: "real-01", synthetic: false },
      { case_id: "real-02", synthetic: false },
    ];

    const passed = await assessHumanG4(caseMetas, [
      humanG4("real-02"),
      humanG4("real-01"),
    ]);
    expect(passed.status).toBe("pass");
    expect(passed.detail).toContain("real-01, real-02");
  });

  it("keeps empty case metadata incomplete instead of passing on unrelated records", async () => {
    const result = await assessHumanG4([], [
      humanG4("unrelated-real-case"),
      humanG4("another-unrelated-real-case"),
    ]);

    expect(result.status).toBe("incomplete");
    expect(result.detail).toContain("0/2");
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

  it("summarizes fresh-env preflight facts without installing dependencies", () => {
    const passed = assessFreshEnvPreflight({
      videoExists: true,
      trackedWorktreeClean: true,
      databaseUrlSet: true,
      workdirEmpty: true,
      workdirSpecified: false,
    });
    expect(passed.pass).toBe(true);
    expect(passed.checks.find((check) => check.name === "workdir.empty")?.detail).toContain("mkdtemp");

    const failed = assessFreshEnvPreflight({
      videoExists: false,
      trackedWorktreeClean: true,
      databaseUrlSet: false,
      workdirEmpty: false,
      workdirSpecified: true,
    });
    expect(failed.pass).toBe(false);
    expect(failed.checks.filter((check) => !check.pass).map((check) => check.name)).toEqual([
      "video.exists",
      "database_url.set",
      "workdir.empty",
    ]);
  });
});
