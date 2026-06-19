import "dotenv/config";
import { execFile } from "child_process";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

type Options = {
  video?: string;
  outdir: string;
  useAudio: boolean;
  asrProvider: string;
  ocrProvider: string;
  audioMode: string;
  maxFrames?: number;
};

type CommandResult = {
  command: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
};

type Check = {
  name: string;
  pass: boolean;
  detail: string;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    outdir: path.join(repoRoot, "outputs", "v1-smoke"),
    useAudio: false,
    asrProvider: "none",
    ocrProvider: "none",
    audioMode: "silent",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") {
      continue;
    } else if (arg === "--video") {
      if (!next || next.startsWith("--")) throw new Error("--video requires a value");
      options.video = path.resolve(next);
      i += 1;
    } else if (arg === "--outdir") {
      if (!next || next.startsWith("--")) throw new Error("--outdir requires a value");
      options.outdir = path.resolve(next);
      i += 1;
    } else if (arg === "--use-audio") {
      if (!next || next.startsWith("--")) throw new Error("--use-audio requires true or false");
      options.useAudio = next !== "false";
      i += 1;
    } else if (arg === "--asr-provider") {
      if (!next || next.startsWith("--")) throw new Error("--asr-provider requires a value");
      options.asrProvider = next;
      i += 1;
    } else if (arg === "--ocr-provider") {
      if (!next || next.startsWith("--")) throw new Error("--ocr-provider requires a value");
      options.ocrProvider = next;
      i += 1;
    } else if (arg === "--audio-mode") {
      if (!next || next.startsWith("--")) throw new Error("--audio-mode requires a value");
      options.audioMode = next;
      i += 1;
    } else if (arg === "--max-frames") {
      if (!next || next.startsWith("--")) throw new Error("--max-frames requires a value");
      options.maxFrames = Number(next);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.video) {
    throw new Error("--video is required");
  }
  if (options.maxFrames !== undefined && (!Number.isInteger(options.maxFrames) || options.maxFrames <= 0)) {
    throw new Error("--max-frames must be a positive integer");
  }
  return options;
}

function printHelp(): void {
  console.log(`Usage:
  pnpm v1:smoke -- --video ./sample.mp4 [--outdir ./outputs/v1-smoke] \\
    [--use-audio false] [--asr-provider none] [--ocr-provider none] \\
    [--audio-mode silent] [--max-frames 12]

Runs setup:check, pipeline:generate, project:export, and edit:smoke, then writes one summary JSON.
`);
}

async function runPnpm(args: string[], timeoutMs: number): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync("pnpm", args, {
      cwd: repoRoot,
      timeout: timeoutMs,
      maxBuffer: 30 * 1024 * 1024,
    });
    return {
      command: ["pnpm", ...args],
      stdout,
      stderr,
      exitCode: 0,
    };
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string; code?: number | string };
    return {
      command: ["pnpm", ...args],
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message,
      exitCode: typeof failure.code === "number" ? failure.code : 1,
    };
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function sha256(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function parseProjectId(stdout: string): number {
  const match = stdout.match(/Created project:\s*(\d+)/);
  if (!match) {
    throw new Error("Could not parse project id from pipeline output");
  }
  return Number(match[1]);
}

function check(name: string, pass: boolean, detail: string): Check {
  return { name, pass, detail };
}

function rel(filePath: string): string {
  return path.relative(repoRoot, filePath);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const videoPath = options.video as string;
  await fs.mkdir(options.outdir, { recursive: true });

  const pipelineOutdir = path.join(options.outdir, "pipeline");
  const exportOutdir = path.join(options.outdir, "project-export");
  const editOutdir = path.join(options.outdir, "edit-smoke");
  await fs.mkdir(pipelineOutdir, { recursive: true });

  const commands: CommandResult[] = [];
  const checks: Check[] = [];
  const summaryPath = path.join(options.outdir, "v1_smoke_summary.json");
  let projectId: number | null = null;
  let stepsPath: string | null = null;
  let stepsHash: string | null = null;
  let exportSummaryPath: string | null = null;
  let editSummaryPath: string | null = null;
  let stepCount = 0;
  let needsReviewCount = 0;
  let fallbackReasonCount = 0;

  const writeSummary = async (pass: boolean): Promise<void> => {
    const summary = {
      generated_at: new Date().toISOString(),
      pass,
      project_id: projectId,
      input_video: rel(videoPath),
      options: {
        use_audio: options.useAudio,
        asr_provider: options.asrProvider,
        ocr_provider: options.ocrProvider,
        audio_mode: options.audioMode,
        max_frames: options.maxFrames ?? null,
      },
      artifacts: {
        steps: stepsPath ? rel(stepsPath) : null,
        steps_sha256: stepsHash,
        export_summary: exportSummaryPath ? rel(exportSummaryPath) : null,
        edit_smoke_summary: editSummaryPath ? rel(editSummaryPath) : null,
      },
      metrics: {
        step_count: stepCount,
        needs_review_count: needsReviewCount,
        fallback_reason_count: fallbackReasonCount,
      },
      checks,
      commands: commands.map((result) => ({
        command: result.command.join(" "),
        exit_code: result.exitCode,
        stdout_tail: result.stdout.split("\n").slice(-20).join("\n"),
        stderr_tail: result.stderr.split("\n").slice(-20).join("\n"),
      })),
      caveat: "This is a machine smoke for setup-to-generation path. It does not replace human UI QA, PPTX visual inspection, or human_review G4.",
    };
    await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  };

  const runRequired = async (name: string, args: string[], timeoutMs: number): Promise<CommandResult> => {
    const result = await runPnpm(args, timeoutMs);
    commands.push(result);
    checks.push(check(name, result.exitCode === 0, `exit_code=${result.exitCode}`));
    if (result.exitCode !== 0) {
      await writeSummary(false);
      throw new Error(`${name} failed; see ${rel(summaryPath)}`);
    }
    return result;
  };

  try {
    await runRequired("setup.check", ["setup:check"], 60_000);

    const pipelineArgs = [
      "pipeline:generate",
      "--",
      "--video",
      videoPath,
      "--outdir",
      pipelineOutdir,
      "--use-audio",
      String(options.useAudio),
      "--asr-provider",
      options.asrProvider,
      "--ocr-provider",
      options.ocrProvider,
    ];
    if (options.maxFrames !== undefined) {
      pipelineArgs.push("--max-frames", String(options.maxFrames));
    }
    const pipelineResult = await runRequired("pipeline.generate", pipelineArgs, 20 * 60_000);

    projectId = parseProjectId(pipelineResult.stdout);
    stepsPath = path.join(pipelineOutdir, `project_${projectId}_steps.json`);
    const stepsArtifact = await readJson<{
      version?: string;
      steps?: Array<{ needs_review?: boolean; review_reasons?: string[] }>;
    }>(stepsPath);
    stepsHash = await sha256(stepsPath);
    stepCount = stepsArtifact.steps?.length ?? 0;
    needsReviewCount = stepsArtifact.steps?.filter((step) => step.needs_review).length ?? 0;
    fallbackReasonCount = stepsArtifact.steps
      ?.flatMap((step) => step.review_reasons ?? [])
      .filter((reason) => reason.startsWith("fallback:")).length ?? 0;
    checks.push(check("steps.version", stepsArtifact.version === "2.0", `version=${stepsArtifact.version ?? "missing"}`));
    checks.push(check("steps.count", stepCount > 0, `steps=${stepCount}`));
    checks.push(check("steps.fallback_reasons", fallbackReasonCount === 0, `fallback_reasons=${fallbackReasonCount}`));

    await runRequired("project.export", [
      "project:export",
      "--",
      "--project-id",
      String(projectId),
      "--audio-mode",
      options.audioMode,
      "--outdir",
      exportOutdir,
    ], 10 * 60_000);
    exportSummaryPath = path.join(exportOutdir, `project_${projectId}_export_summary.json`);
    const exportSummary = await readJson<{
      slide?: { bytes?: number | null; content_check?: { status?: string; warnings?: string[] } };
      video?: { bytes?: number | null; still_image_fallback_count?: number; warnings?: string[] };
    }>(exportSummaryPath);
    checks.push(check("export.slide.bytes", (exportSummary.slide?.bytes ?? 0) > 0, `bytes=${exportSummary.slide?.bytes ?? "null"}`));
    checks.push(check(
      "export.slide.content_check",
      exportSummary.slide?.content_check?.status === "pass",
      `status=${exportSummary.slide?.content_check?.status ?? "missing"}`,
    ));
    checks.push(check("export.video.bytes", (exportSummary.video?.bytes ?? 0) > 0, `bytes=${exportSummary.video?.bytes ?? "null"}`));
    checks.push(check(
      "export.video.still_image_fallback_count",
      exportSummary.video?.still_image_fallback_count === 0,
      `still_image_fallback_count=${exportSummary.video?.still_image_fallback_count ?? "missing"}`,
    ));

    await runRequired("edit.smoke", [
      "edit:smoke",
      "--",
      "--project-id",
      String(projectId),
      "--outdir",
      editOutdir,
    ], 5 * 60_000);
    editSummaryPath = path.join(editOutdir, `project_${projectId}_edit_smoke_summary.json`);
    const editSummary = await readJson<{ pass?: boolean; restored_after_check?: boolean; restore_error?: string | null }>(
      editSummaryPath,
    );
    checks.push(check(
      "edit.summary",
      editSummary.pass === true && editSummary.restored_after_check === true && editSummary.restore_error === null,
      `pass=${String(editSummary.pass)} restored_after_check=${String(editSummary.restored_after_check)} restore_error=${editSummary.restore_error ?? "null"}`,
    ));
  } catch (error) {
    if (!checks.some((item) => item.name === "v1.smoke.exception")) {
      checks.push(check("v1.smoke.exception", false, error instanceof Error ? error.message : String(error)));
    }
    await writeSummary(false);
    throw error;
  }

  const pass = checks.every((item) => item.pass);
  await writeSummary(pass);
  console.log(`v1 smoke summary: ${rel(summaryPath)}`);
  console.log(await fs.readFile(summaryPath, "utf8"));

  if (!pass) {
    throw new Error(`v1 smoke failed; see ${rel(summaryPath)}`);
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
