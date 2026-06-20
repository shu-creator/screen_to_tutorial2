import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { buildReviewPack, writeReviewPack } from "../scripts/g4-review-pack";

describe("g4 review pack helper", () => {
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
});
