import { execFile } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";
import { describe, expect, it } from "vitest";
import {
  buildPreflightChecks,
  buildPreflightLines,
  parseArgs,
} from "./generatePipeline";

const execFileAsync = promisify(execFile);

describe("generate pipeline CLI helpers", () => {
  it("parses preflight without changing the existing dry-run flag", () => {
    const options = parseArgs([
      "--video",
      "eval/dataset/real-app-workflow-03-generate-steps/video.mp4",
      "--outdir",
      "outputs/post-v1-prompt-check/case-03",
      "--use-audio",
      "false",
      "--asr-provider",
      "none",
      "--preflight",
    ]);

    expect(options.video).toBe("eval/dataset/real-app-workflow-03-generate-steps/video.mp4");
    expect(options.outdir).toBe(path.resolve(process.cwd(), "outputs/post-v1-prompt-check/case-03"));
    expect(options.useAudio).toBe(false);
    expect(options.asrProvider).toBe("none");
    expect(options.preflight).toBe(true);
    expect(options.dryRun).toBe(false);
  });

  it("describes the no-write preflight plan and dry-run side effects", () => {
    const options = parseArgs([
      "--video",
      "sample.mp4",
      "--outdir",
      "outputs/demo",
      "--use-audio",
      "false",
      "--dry-run",
      "--preflight",
      "--max-frames",
      "12",
    ]);

    const lines = buildPreflightLines(options);

    expect(lines).toContain("Pipeline preflight: PLAN");
    expect(lines).toContain(`video: ${path.resolve(process.cwd(), "sample.mp4")}`);
    expect(lines).toContain(`outdir: ${path.resolve(process.cwd(), "outputs/demo")}`);
    expect(lines).toContain("use_audio: false");
    expect(lines).toContain("asr_provider: none");
    expect(lines).toContain("max_frames: 12");
    expect(lines).toContain("- create the output directory");
    expect(lines).toContain(
      "- create or update the CLI local user in the configured database",
    );
    expect(lines).toContain(
      "dry_run_note: existing --dry-run still creates the CLI user, stores the source video, and creates a database project before skipping processing.",
    );
  });

  it("reports Codex App Server preflight constraints before execution", () => {
    const options = parseArgs([
      "--video",
      "sample.mp4",
      "--outdir",
      "outputs/demo",
      "--use-audio",
      "false",
      "--asr-provider",
      "none",
      "--preflight",
    ]);

    const checks = buildPreflightChecks(options, {
      AUTHORING_PROVIDER: "codex_app_server",
      OCR_PROVIDER: "llm",
      TTS_PROVIDER: "none",
      CODEX_MODEL: "",
    } as NodeJS.ProcessEnv);

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "PASS",
          code: "evidence_required",
        }),
        expect.objectContaining({
          status: "FAIL",
          code: "ocr_provider",
        }),
        expect.objectContaining({
          status: "FAIL",
          code: "tts_provider",
        }),
        expect.objectContaining({
          status: "WARN",
          code: "codex_model",
        }),
      ])
    );

    const lines = buildPreflightLines(options, "FAIL", checks, {
      AUTHORING_PROVIDER: "codex_app_server",
      OCR_PROVIDER: "llm",
      TTS_PROVIDER: "none",
      CODEX_MODEL: "",
    } as NodeJS.ProcessEnv);
    expect(lines).toContain("authoring_provider: codex_app_server");
    expect(lines).toContain("ocr_provider: llm");
  });

  it("runs preflight before creating the output directory", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "generate-pipeline-preflight-test-")
    );
    const outdir = path.join(tempDir, "out");
    const video = path.join(tempDir, "sample.mp4");
    await fs.writeFile(video, "preflight only");

    await expect(fs.rm(outdir, { recursive: true, force: true })).resolves.toBeUndefined();

    const { stdout } = await execFileAsync(
      "pnpm",
      [
        "tsx",
        "server/cli/generatePipeline.ts",
        "--video",
        video,
        "--outdir",
        outdir,
        "--use-audio",
        "false",
        "--asr-provider",
        "none",
        "--preflight",
      ],
      { cwd: process.cwd(), timeout: 15_000 },
    );

    expect(stdout).toContain("Pipeline preflight: PASS");
    expect(stdout).toContain(`outdir: ${outdir}`);
    await expect(fs.access(outdir)).rejects.toThrow();
  }, 15_000);

  it("fails codex preflight before creating the output directory when settings are incompatible", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "generate-pipeline-codex-preflight-test-")
    );
    const outdir = path.join(tempDir, "out");
    const video = path.join(tempDir, "sample.mp4");
    await fs.writeFile(video, "preflight only");

    await expect(
      execFileAsync(
        "pnpm",
        [
          "tsx",
          "server/cli/generatePipeline.ts",
          "--video",
          video,
          "--outdir",
          outdir,
          "--use-audio",
          "false",
          "--asr-provider",
          "none",
          "--preflight",
        ],
        {
          cwd: process.cwd(),
          timeout: 20_000,
          env: {
            ...process.env,
            AUTHORING_PROVIDER: "codex_app_server",
            OCR_PROVIDER: "llm",
            TTS_PROVIDER: "none",
            CODEX_MODEL: "",
          },
        }
      )
    ).rejects.toMatchObject({
      stdout: expect.stringContaining("Pipeline preflight: FAIL"),
    });
    await expect(fs.access(outdir)).rejects.toThrow();
  }, 20_000);
});
