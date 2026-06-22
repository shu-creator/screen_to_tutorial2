import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  buildReviewPack,
  emptySelectionMessage,
  parseArgs,
  resolveSelectedCases,
  selectMissingHumanReviewCases,
  selectReleaseCandidateCases,
  writeOrPreviewReviewPack,
  writeReviewPack,
} from "../scripts/g4-review-pack";

describe("g4 review pack helper", () => {
  it("parses dry-run review packet selection without requiring case ids", () => {
    const options = parseArgs(["--missing-human-review", "--dry-run", "--limit", "3"]);

    expect(options.missingHumanReview).toBe(true);
    expect(options.dryRun).toBe(true);
    expect(options.limit).toBe(3);
    expect(options.cases).toEqual([]);
  });

  it("treats an empty missing-human-review selection as a close-out no-op", () => {
    const options = parseArgs(["--missing-human-review", "--dry-run"]);
    const logs: string[] = [];

    expect(emptySelectionMessage(options)).toBe("no real generated cases without human_review G4 found");
    expect(resolveSelectedCases(options, [], [], (message) => logs.push(message))).toEqual([]);
    expect(logs).toEqual(["no real generated cases without human_review G4 found"]);
  });

  it("keeps an empty release-candidate selection as a failure", () => {
    const options = parseArgs(["--release-candidates", "--dry-run"]);

    expect(() => resolveSelectedCases(options, [], [], () => undefined)).toThrow(
      "no release candidate cases found from eval/results/export-qa",
    );
  });

  it("previews review packets without writing files in dry-run mode", async () => {
    const outputsOutdir = path.join(process.cwd(), "outputs", "g4-review-pack-dry-run-test");
    const pack = await buildReviewPack("real-app-workflow-04-export-video", outputsOutdir);
    const logs: string[] = [];

    try {
      await fs.rm(outputsOutdir, { recursive: true, force: true });
      await expect(
        writeOrPreviewReviewPack(pack, {
          dryRun: true,
          overwrite: true,
          log: (message) => logs.push(message),
        }),
      ).resolves.toBe("dry-run");
      await expect(fs.access(pack.outPath)).rejects.toThrow();
      expect(logs).toEqual([
        "G4 review packet dry-run: real-app-workflow-04-export-video -> outputs/g4-review-pack-dry-run-test/real-app-workflow-04-export-video.md",
      ]);

      await expect(
        writeOrPreviewReviewPack(pack, {
          dryRun: false,
          overwrite: false,
          log: (message) => logs.push(message),
        }),
      ).resolves.toBe("written");
      await expect(fs.access(pack.outPath)).resolves.toBeUndefined();
    } finally {
      await fs.rm(outputsOutdir, { recursive: true, force: true });
    }
  });

  it("builds a worksheet without creating a human_review record", async () => {
    const caseId = "tmp-review-pack-test";
    const generatedDir = path.join(process.cwd(), "eval", "results", "generated", caseId);
    const exportDir = path.join(process.cwd(), "eval", "results", "export-qa", caseId);
    const g4Path = path.join(process.cwd(), "eval", "g4", "records", `${caseId}.json`);
    const originalG4Record = `${JSON.stringify({
      review_type: "ai_estimate",
      total_manual_edits: 2,
    })}\n`;

    try {
      await fs.mkdir(generatedDir, { recursive: true });
      await fs.mkdir(exportDir, { recursive: true });
      await fs.writeFile(path.join(generatedDir, "steps.json"), JSON.stringify({
        steps: [{
          title: "Open export screen",
          t_start: 0,
          t_end: 1500,
          needs_review: true,
          review_reasons: ["verification:low_confidence"],
          warnings: ["check UI label"],
          cited_ui_labels: ["Export"],
        }],
      }));
      await fs.writeFile(path.join(exportDir, "qa-summary.json"), JSON.stringify({
        case_id: caseId,
        steps: 1,
        needs_review_steps: 1,
        integrity: {
          steps_sha256_matches_g4: true,
          video_sha256_matches_meta: true,
          warnings: [],
        },
        artifacts: {
          pptx: `eval/results/export-qa/${caseId}/${caseId}.pptx`,
          video: `eval/results/export-qa/${caseId}/${caseId}.mp4`,
        },
        qa_checks: {
          pptx: {
            cover_slide: true,
            completion_slide: true,
            slide_count: 3,
            expected_slide_count: 3,
            speaker_notes_review_warnings: 1,
          },
          video: {
            duration_sec: 4.2,
            audio_stream: true,
            audio_content: "synthetic_silence",
            resolved_audio_modes: { silent: 1 },
          },
        },
      }));
      await fs.writeFile(g4Path, originalG4Record);

      const pack = await buildReviewPack(caseId);

      expect(pack.markdown).toContain(`# G4 Human Review Packet: ${caseId}`);
      expect(pack.markdown).toContain("This worksheet is not a `human_review` G4 record");
      expect(pack.markdown).toContain(`eval/results/export-qa/${caseId}/${caseId}.pptx`);
      expect(pack.markdown).toContain(`pnpm g4:record -- --case ${caseId}`);
      expect(pack.markdown).toContain("| title_edits | 0 |");
      expect(pack.markdown).toContain("verification:low_confidence");
      expect(pack.markdown).toContain("ai_estimate");
      await expect(fs.readFile(g4Path, "utf8")).resolves.toBe(originalG4Record);
    } finally {
      await fs.rm(generatedDir, { recursive: true, force: true });
      await fs.rm(exportDir, { recursive: true, force: true });
      await fs.rm(g4Path, { force: true });
    }
  });

  it("rejects path traversal through case id", async () => {
    await expect(buildReviewPack("../escape")).rejects.toThrow("must not contain path separators");
    await expect(buildReviewPack("..")).rejects.toThrow("must not be a directory reference");
  });

  it("protects existing packets unless overwrite is explicit", async () => {
    const tempOutdir = await fs.mkdtemp(path.join(os.tmpdir(), "g4-review-pack-"));
    const outputsOutdir = path.join(process.cwd(), "outputs", path.basename(tempOutdir));
    const pack = await buildReviewPack("real-app-workflow-04-export-video", outputsOutdir);

    try {
      await fs.mkdir(outputsOutdir, { recursive: true });
      await fs.writeFile(pack.outPath, "existing\n");
      await expect(writeReviewPack(pack, false)).rejects.toThrow("already exists");
      await writeReviewPack(pack, true);
      const written = await fs.readFile(pack.outPath, "utf8");
      expect(written).toContain("G4 Human Review Packet");
    } finally {
      await fs.rm(outputsOutdir, { recursive: true, force: true });
      await fs.rm(tempOutdir, { recursive: true, force: true });
    }
  });

  it("resolves relative outdir against the repo root", async () => {
    const pack = await buildReviewPack("case-01", "outputs/g4-review-pack-relative-test");

    expect(pack.outPath).toBe(path.join(process.cwd(), "outputs", "g4-review-pack-relative-test", "case-01.md"));
  });

  it("rejects output outside outputs", async () => {
    const tempOutdir = await fs.mkdtemp(path.join(os.tmpdir(), "g4-review-pack-"));
    const pack = await buildReviewPack("real-app-workflow-04-export-video", tempOutdir);

    try {
      await expect(writeReviewPack(pack, true)).rejects.toThrow("--outdir must be inside outputs/");
    } finally {
      await fs.rm(tempOutdir, { recursive: true, force: true });
    }
  });

  it("selects release candidates from valid export QA cases without human_review records", async () => {
    const caseId = "tmp-review-pack-release-candidate";
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "g4-review-pack-candidates-"));
    const datasetRoot = path.join(tempRoot, "dataset");
    const exportRoot = path.join(tempRoot, "export-qa");
    const recordsDir = path.join(tempRoot, "records");
    const datasetDir = path.join(datasetRoot, caseId);
    const exportDir = path.join(exportRoot, caseId);
    const g4Path = path.join(recordsDir, `${caseId}.json`);

    try {
      await fs.mkdir(datasetDir, { recursive: true });
      await fs.mkdir(exportDir, { recursive: true });
      await fs.mkdir(recordsDir, { recursive: true });
      await fs.writeFile(path.join(datasetDir, "meta.json"), `${JSON.stringify({
        case_id: caseId,
        synthetic: false,
      })}\n`);
      await fs.writeFile(path.join(exportDir, `${caseId}.pptx`), "pptx");
      await fs.writeFile(path.join(exportDir, `${caseId}.mp4`), "mp4");
      await fs.writeFile(path.join(exportDir, "qa-summary.json"), `${JSON.stringify({
        case_id: caseId,
        artifacts: {
          pptx: path.join(exportDir, `${caseId}.pptx`),
          video: path.join(exportDir, `${caseId}.mp4`),
        },
        qa_checks: {
          pptx: {
            cover_slide: true,
            completion_slide: true,
            slide_count: 3,
            expected_slide_count: 3,
          },
          video: {
            duration_sec: 2.5,
            audio_stream: true,
          },
        },
      })}\n`);

      await expect(selectReleaseCandidateCases(99, { datasetRoot, exportRoot, recordsDir })).resolves.toContain(caseId);

      await fs.writeFile(g4Path, `${JSON.stringify({ review_type: "ai_estimate" })}\n`);

      await expect(selectReleaseCandidateCases(99, { datasetRoot, exportRoot, recordsDir })).resolves.toContain(caseId);

      await fs.writeFile(g4Path, `${JSON.stringify({ review_type: "human_review" })}\n`);
      await expect(selectReleaseCandidateCases(99, { datasetRoot, exportRoot, recordsDir })).resolves.not.toContain(caseId);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("selects real generated cases without human_review records", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "g4-review-pack-open-"));
    const datasetRoot = path.join(tempRoot, "dataset");
    const generatedRoot = path.join(tempRoot, "generated");
    const recordsDir = path.join(tempRoot, "records");

    async function writeCase(caseId: string, synthetic: boolean, withGenerated: boolean, reviewType?: string | null): Promise<void> {
      await fs.mkdir(path.join(datasetRoot, caseId), { recursive: true });
      await fs.writeFile(path.join(datasetRoot, caseId, "meta.json"), `${JSON.stringify({
        case_id: caseId,
        synthetic,
      })}\n`);
      if (withGenerated) {
        await fs.mkdir(path.join(generatedRoot, caseId), { recursive: true });
        await fs.writeFile(path.join(generatedRoot, caseId, "steps.json"), `${JSON.stringify({ steps: [] })}\n`);
      }
      if (reviewType !== undefined) {
        await fs.mkdir(recordsDir, { recursive: true });
        await fs.writeFile(path.join(recordsDir, `${caseId}.json`), `${JSON.stringify({ review_type: reviewType })}\n`);
      }
    }

    try {
      await fs.mkdir(recordsDir, { recursive: true });
      await writeCase("real-open", false, true, "ai_estimate");
      await writeCase("real-without-record", false, true);
      await writeCase("real-znull-record", false, true, null);
      await writeCase("real-missing-generated", false, false, "ai_estimate");
      await writeCase("real-human", false, true, "human_review");
      await writeCase("synthetic-open", true, true, "ai_estimate");

      await expect(
        selectMissingHumanReviewCases(99, { datasetRoot, generatedRoot, recordsDir }),
      ).resolves.toEqual(["real-open", "real-without-record", "real-znull-record"]);

      await expect(
        selectMissingHumanReviewCases(1, { datasetRoot, generatedRoot, recordsDir }),
      ).resolves.toEqual(["real-open"]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not select export QA summaries without explicit slide counts", async () => {
    const caseId = "tmp-review-pack-missing-slide-counts";
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "g4-review-pack-candidates-"));
    const datasetRoot = path.join(tempRoot, "dataset");
    const exportRoot = path.join(tempRoot, "export-qa");
    const recordsDir = path.join(tempRoot, "records");
    const datasetDir = path.join(datasetRoot, caseId);
    const exportDir = path.join(exportRoot, caseId);

    try {
      await fs.mkdir(datasetDir, { recursive: true });
      await fs.mkdir(exportDir, { recursive: true });
      await fs.mkdir(recordsDir, { recursive: true });
      await fs.writeFile(path.join(datasetDir, "meta.json"), `${JSON.stringify({
        case_id: caseId,
        synthetic: false,
      })}\n`);
      await fs.writeFile(path.join(exportDir, `${caseId}.pptx`), "pptx");
      await fs.writeFile(path.join(exportDir, `${caseId}.mp4`), "mp4");
      await fs.writeFile(path.join(exportDir, "qa-summary.json"), `${JSON.stringify({
        case_id: caseId,
        artifacts: {
          pptx: path.join(exportDir, `${caseId}.pptx`),
          video: path.join(exportDir, `${caseId}.mp4`),
        },
        qa_checks: {
          pptx: {
            cover_slide: true,
            completion_slide: true,
          },
          video: {
            duration_sec: 2.5,
            audio_stream: true,
          },
        },
      })}\n`);

      await expect(selectReleaseCandidateCases(99, { datasetRoot, exportRoot, recordsDir })).resolves.not.toContain(caseId);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not select export QA summaries with zero slides", async () => {
    const caseId = "tmp-review-pack-zero-slides";
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "g4-review-pack-candidates-"));
    const datasetRoot = path.join(tempRoot, "dataset");
    const exportRoot = path.join(tempRoot, "export-qa");
    const recordsDir = path.join(tempRoot, "records");
    const datasetDir = path.join(datasetRoot, caseId);
    const exportDir = path.join(exportRoot, caseId);

    try {
      await fs.mkdir(datasetDir, { recursive: true });
      await fs.mkdir(exportDir, { recursive: true });
      await fs.mkdir(recordsDir, { recursive: true });
      await fs.writeFile(path.join(datasetDir, "meta.json"), `${JSON.stringify({
        case_id: caseId,
        synthetic: false,
      })}\n`);
      await fs.writeFile(path.join(exportDir, `${caseId}.pptx`), "pptx");
      await fs.writeFile(path.join(exportDir, `${caseId}.mp4`), "mp4");
      await fs.writeFile(path.join(exportDir, "qa-summary.json"), `${JSON.stringify({
        case_id: caseId,
        artifacts: {
          pptx: path.join(exportDir, `${caseId}.pptx`),
          video: path.join(exportDir, `${caseId}.mp4`),
        },
        qa_checks: {
          pptx: {
            cover_slide: true,
            completion_slide: true,
            slide_count: 0,
            expected_slide_count: 0,
          },
          video: {
            duration_sec: 2.5,
            audio_stream: true,
          },
        },
      })}\n`);

      await expect(selectReleaseCandidateCases(99, { datasetRoot, exportRoot, recordsDir })).resolves.not.toContain(caseId);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
