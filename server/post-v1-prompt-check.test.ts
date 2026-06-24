import path from "path";
import { describe, expect, it } from "vitest";
import {
  buildPromptCheckPlan,
  formatReviewPacket,
  formatPlan,
  parseArgs,
  repoRoot,
  validateExecutionOptions,
} from "../scripts/post-v1-prompt-check";

describe("post-v1 prompt check helper", () => {
  it("prints a no-write plan by default for the next priority low-G3 case", () => {
    const options = parseArgs(["--", "--run-id", "test-run"]);
    const plan = buildPromptCheckPlan(options);
    const text = formatPlan(plan, options.execute);

    expect(options.execute).toBe(false);
    expect(options.explicitCase).toBe(false);
    expect(plan.caseId).toBe("real-app-workflow-01");
    expect(plan.outdir).toBe(path.join(repoRoot, "outputs", "post-v1-prompt-check", "real-app-workflow-01-run-test-run"));
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

  it("keeps explicit case selection independent from the default case", () => {
    const options = parseArgs([
      "--case",
      "real-app-workflow-03-generate-steps",
      "--run-id",
      "case-03-recovery",
    ]);
    const plan = buildPromptCheckPlan(options);

    expect(options.explicitCase).toBe(true);
    expect(plan.caseId).toBe("real-app-workflow-03-generate-steps");
    expect(plan.outdir).toBe(
      path.join(
        repoRoot,
        "outputs",
        "post-v1-prompt-check",
        "real-app-workflow-03-generate-steps-run-case-03-recovery",
      ),
    );
    expect(plan.executeCommand.join(" ")).toContain("real-app-workflow-03-generate-steps/video.mp4");
    expect(plan.evalCommandTemplate).toContain("--case real-app-workflow-03-generate-steps");
  });

  it("requires explicit side-effect acceptance before execute mode", () => {
    const options = parseArgs(["--execute", "--run-id", "test-run"]);

    expect(() => validateExecutionOptions(options)).toThrow("--execute requires --accept-side-effects");

    const accepted = parseArgs(["--execute", "--accept-side-effects", "--run-id", "test-run"]);
    expect(() => validateExecutionOptions(accepted)).not.toThrow();

    const acceptOnly = parseArgs(["--accept-side-effects", "--run-id", "test-run"]);
    expect(() => validateExecutionOptions(acceptOnly)).toThrow("--accept-side-effects requires --execute");
  });

  it("validates review-packet mode independently from execute mode", () => {
    const options = parseArgs([
      "--review-packet",
      "--case",
      "real-app-workflow-03-generate-steps",
      "--steps",
      "outputs/run/project_40_steps.json",
      "--export-summary",
      "outputs/run/export/project_40_export_summary.json",
      "--out",
      "outputs/run/human-review-packet.md",
    ]);

    expect(options.reviewPacket).toBe(true);
    expect(options.explicitCase).toBe(true);
    expect(options.stepsPath).toBe(path.join(repoRoot, "outputs", "run", "project_40_steps.json"));
    expect(options.exportSummaryPath).toBe(path.join(repoRoot, "outputs", "run", "export", "project_40_export_summary.json"));
    expect(options.reviewPacketOut).toBe(path.join(repoRoot, "outputs", "run", "human-review-packet.md"));
    expect(() => validateExecutionOptions(options)).not.toThrow();

    expect(() => validateExecutionOptions(parseArgs(["--review-packet", "--case", "test-case"]))).toThrow(
      "--review-packet requires --steps",
    );
    expect(() => validateExecutionOptions(parseArgs(["--review-packet", "--steps", "steps.json"]))).toThrow(
      "--review-packet requires --export-summary",
    );
    expect(() =>
      validateExecutionOptions(parseArgs(["--review-packet", "--steps", "steps.json", "--export-summary", "summary.json"])),
    ).toThrow("--review-packet requires --out");
    expect(() =>
      validateExecutionOptions(
        parseArgs([
          "--review-packet",
          "--steps",
          "steps.json",
          "--export-summary",
          "summary.json",
          "--out",
          "packet.md",
        ]),
      ),
    ).toThrow("--review-packet requires explicit --case");
    expect(() =>
      validateExecutionOptions(
        parseArgs([
          "--review-packet",
          "--execute",
          "--accept-side-effects",
          "--steps",
          "steps.json",
          "--export-summary",
          "summary.json",
          "--out",
          "packet.md",
        ]),
      ),
    ).toThrow("--review-packet cannot be combined with --execute or --accept-side-effects");
  });

  it("formats a local human review packet without recording G4", () => {
    const markdown = formatReviewPacket({
      caseId: "test-case-id",
      stepsPath: path.join(repoRoot, "outputs", "run", "project_40_steps.json"),
      stepsSha256: "steps-hash",
      exportSummaryPath: path.join(repoRoot, "outputs", "run", "export", "project_40_export_summary.json"),
      pptxSha256: "pptx-hash",
      videoSha256: "video-hash",
      stepsArtifact: {
        project_id: 40,
        config: { prompt_version: "authoring-v2-grounded-3" },
        overview: {
          task_title: "動画処理後にステップ生成を開始する",
          preconditions: ["対象プロジェクトが表示されている"],
          completion_criteria: "AIでステップ生成を開始する。",
        },
        steps: [
          {
            title: "AIでステップ生成 | 開始する",
            t_start: 61500,
            t_end: 65500,
            needs_review: false,
            warnings: ["first line\nsecond | line"],
            cited_ui_labels: ["「AIで`ステップを生成」"],
          },
        ],
      },
      summary: {
        project_id: 40,
        requested_audio_mode: "silent",
        slide: {
          path: "data/storage/projects/40/slides/example.pptx",
          content_check: {
            status: "pass",
            total_slide_count: 7,
            media_image_count: 4,
            slides_with_images: 4,
            expected_step_image_count: 4,
            expected_step_image_count_source: "steps_artifact",
            notes_review_warning_count: 0,
            placeholder_text_hits: [],
          },
        },
        video: {
          path: "data/storage/projects/40/videos/example.mp4",
          bytes: 123,
          warnings: ["使用可能なフォントが無いためイントロカードをスキップしました"],
          still_image_fallback_count: 0,
        },
      },
    });

    expect(markdown).toContain("# Project 40 Human Review Packet");
    expect(markdown).toContain("Case: `test-case-id`");
    expect(markdown).toContain("This worksheet is not a `human_review` G4 record");
    expect(markdown).toContain("Candidate steps SHA-256: `steps-hash`");
    expect(markdown).toContain("PPTX SHA-256: `pptx-hash`");
    expect(markdown).toContain("MP4 SHA-256: `video-hash`");
    expect(markdown).toContain("Replacing the persisted generated artifact invalidates any previous G4");
    expect(markdown).toContain("record a replacement `human_review` G4 with `--overwrite`");
    expect(markdown).toContain(
      "| 1 | 61.5s-65.5s | AIでステップ生成 \\| 開始する | no | - | first line second \\| line | `「AIで\\`ステップを生成」` |",
    );
    expect(markdown).toContain("eval/results/generated/test-case-id/steps.json");
    expect(markdown).toContain("--case test-case-id");
    expect(markdown).toContain('--reviewer "<reviewer>"');
    expect(markdown).toContain("--reviewed-at YYYY-MM-DD");
    expect(markdown).toContain("Human reviewed promoted authoring-v2-grounded-3 candidate and export artifacts.");
    expect(markdown).not.toContain('--reviewer "iwsh23"');
    expect(markdown).not.toContain("--reviewed-at 2026-06-21");
    expect(markdown).not.toContain("real-app-workflow-03-generate-steps");
  });

  it("formats an empty step review table for artifacts without steps", () => {
    const markdown = formatReviewPacket({
      caseId: "empty-case",
      stepsPath: path.join(repoRoot, "outputs", "run", "project_41_steps.json"),
      stepsSha256: "steps-hash",
      exportSummaryPath: path.join(repoRoot, "outputs", "run", "export", "project_41_export_summary.json"),
      pptxSha256: "missing path in export summary",
      videoSha256: "missing local file",
      stepsArtifact: {
        project_id: 41,
        config: { prompt_version: "authoring-v2-test" },
      },
      summary: {
        project_id: 41,
      },
    });

    expect(markdown).toContain("# Project 41 Human Review Packet");
    expect(markdown).toContain("| # | time | title | needs_review | reasons | warnings | cited_ui_labels |");
    expect(markdown).toContain("PPTX SHA-256: `missing path in export summary`");
    expect(markdown).toContain("MP4 SHA-256: `missing local file`");
    expect(markdown).toContain("Human reviewed promoted authoring-v2-test candidate and export artifacts.");
  });

  it("rejects path traversal case ids", () => {
    expect(() => parseArgs(["--case", "../escape"])).toThrow("must not contain path separators");
    expect(() => parseArgs(["--case", ".."])).toThrow("must not be a directory reference");
  });
});
