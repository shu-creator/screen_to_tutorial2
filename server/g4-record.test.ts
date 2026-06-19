import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { buildG4Record, writeG4Record } from "../scripts/g4-record";

describe("g4 record helper", () => {
  it("requires explicit human-review confirmation", async () => {
    await expect(buildG4Record({
      caseId: "case-01",
      reviewer: "tester",
      reviewedAt: "2026-06-20",
      sourceArtifact: "missing.json",
      notes: "",
      blockingIssues: [],
      exportedArtifacts: [],
      counts: {
        title_edits: 0,
        description_edits: 0,
        narration_edits: 0,
        timing_edits: 0,
        citation_edits: 0,
        step_structure_edits: 0,
        export_artifact_edits: 0,
        other_edits: 0,
      },
      dryRun: true,
      overwrite: false,
      confirmHumanReview: false,
    })).rejects.toThrow("--confirm-human-review is required");
  });

  it("builds a human_review record with sha256 and summed counts", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "g4-record-"));
    const sourceArtifact = path.join(tempDir, "steps.json");
    await fs.writeFile(sourceArtifact, JSON.stringify({ steps: [] }));

    const { record } = await buildG4Record({
      caseId: "case-01",
      reviewer: "tester",
      reviewedAt: "2026-06-20",
      sourceArtifact,
      notes: "reviewed by a human",
      blockingIssues: ["needs export check"],
      exportedArtifacts: ["eval/results/export-qa/case-01/qa-summary.json"],
      counts: {
        title_edits: 1,
        description_edits: 2,
        narration_edits: 0,
        timing_edits: 3,
        citation_edits: 0,
        step_structure_edits: 1,
        export_artifact_edits: 0,
        other_edits: 0,
      },
      dryRun: true,
      overwrite: false,
      confirmHumanReview: true,
    });

    expect(record.review_type).toBe("human_review");
    expect(record.source_artifact_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(record.total_manual_edits).toBe(7);
    expect(record.exported_artifacts).toEqual(["eval/results/export-qa/case-01/qa-summary.json"]);
  });

  it("rejects path traversal through case id or out path", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "g4-record-"));
    const sourceArtifact = path.join(tempDir, "steps.json");
    await fs.writeFile(sourceArtifact, JSON.stringify({ steps: [] }));
    const baseOptions = {
      caseId: "case-01",
      reviewer: "tester",
      reviewedAt: "2026-06-20",
      sourceArtifact,
      notes: "",
      blockingIssues: [],
      exportedArtifacts: [],
      counts: {
        title_edits: 0,
        description_edits: 0,
        narration_edits: 0,
        timing_edits: 0,
        citation_edits: 0,
        step_structure_edits: 0,
        export_artifact_edits: 0,
        other_edits: 0,
      },
      dryRun: true,
      overwrite: false,
      confirmHumanReview: true,
    };

    await expect(buildG4Record({ ...baseOptions, caseId: "../escape" })).rejects.toThrow("must not contain path separators");
    await expect(buildG4Record({ ...baseOptions, out: path.join(tempDir, "record.json") })).rejects.toThrow("inside eval/g4/records");
    await expect(buildG4Record({
      ...baseOptions,
      out: `${path.join(process.cwd(), "eval", "g4", "records")}${path.sep}..${path.sep}evil.json`,
    })).rejects.toThrow("inside eval/g4/records");
  });

  it("protects existing records unless overwrite is explicit", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "g4-record-"));
    const sourceArtifact = path.join(tempDir, "steps.json");
    await fs.writeFile(sourceArtifact, JSON.stringify({ steps: [] }));
    const outPath = path.join(process.cwd(), "eval", "g4", "records", "tmp-human-review-test.json");
    const { record } = await buildG4Record({
      caseId: "tmp-human-review-test",
      reviewer: "tester",
      reviewedAt: "2026-06-20",
      sourceArtifact,
      notes: "",
      blockingIssues: [],
      exportedArtifacts: [],
      counts: {
        title_edits: 0,
        description_edits: 0,
        narration_edits: 0,
        timing_edits: 0,
        citation_edits: 0,
        step_structure_edits: 0,
        export_artifact_edits: 0,
        other_edits: 0,
      },
      dryRun: false,
      overwrite: false,
      confirmHumanReview: true,
    });

    try {
      await fs.writeFile(outPath, "{}\n");
      await expect(writeG4Record(outPath, record, false)).rejects.toThrow("already exists");
      await expect(writeG4Record(path.join(tempDir, "outside.json"), record, true)).rejects.toThrow("inside eval/g4/records");
      await writeG4Record(outPath, record, true);
      const written = JSON.parse(await fs.readFile(outPath, "utf8")) as { review_type?: string };
      expect(written.review_type).toBe("human_review");
    } finally {
      await fs.rm(outPath, { force: true });
    }
  });
});
