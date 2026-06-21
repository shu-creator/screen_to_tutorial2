#!/usr/bin/env node
import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";

export type CliOptions = {
  video?: string;
  outdir: string;
  useAudio: boolean;
  asrProvider?: string;
  ocrProvider?: string;
  cacheDir?: string;
  debug: boolean;
  dryRun: boolean;
  preflight: boolean;
  threshold?: number;
  minInterval?: number;
  maxFrames?: number;
};

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    outdir: path.resolve(process.cwd(), "outputs"),
    useAudio: true,
    debug: false,
    dryRun: false,
    preflight: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    switch (arg) {
      case "--video":
        options.video = next;
        i++;
        break;
      case "--outdir":
        options.outdir = path.resolve(process.cwd(), next);
        i++;
        break;
      case "--use-audio":
        options.useAudio = next !== "false";
        i++;
        break;
      case "--asr-provider":
        options.asrProvider = next;
        i++;
        break;
      case "--ocr-provider":
        options.ocrProvider = next;
        i++;
        break;
      case "--cache-dir":
        options.cacheDir = next;
        i++;
        break;
      case "--debug":
        options.debug = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--preflight":
        options.preflight = true;
        break;
      case "--threshold":
        options.threshold = Number(next);
        i++;
        break;
      case "--min-interval":
        options.minInterval = Number(next);
        i++;
        break;
      case "--max-frames":
        options.maxFrames = Number(next);
        i++;
        break;
      default:
        break;
    }
  }

  return options;
}

function describeProvider(value: string | undefined): string {
  return value ?? "(pipeline default)";
}

export function buildPreflightLines(options: CliOptions, status: "PASS" | "PLAN" = "PLAN"): string[] {
  const videoPath = options.video ? path.resolve(process.cwd(), options.video) : "(missing)";
  const asrProvider = options.asrProvider ?? (!options.useAudio ? "none" : process.env.ASR_PROVIDER);
  const ocrProvider = options.ocrProvider ?? process.env.OCR_PROVIDER;
  const lines = [
    `Pipeline preflight: ${status}`,
    `video: ${videoPath}`,
    `outdir: ${options.outdir}`,
    `use_audio: ${options.useAudio}`,
    `asr_provider: ${describeProvider(asrProvider)}`,
    `ocr_provider: ${describeProvider(ocrProvider)}`,
    `cache_dir: ${options.cacheDir ?? "(not set)"}`,
    `debug: ${options.debug}`,
    `dry_run: ${options.dryRun}`,
    `threshold: ${options.threshold ?? "(pipeline default)"}`,
    `min_interval: ${options.minInterval ?? "(pipeline default)"}`,
    `max_frames: ${options.maxFrames ?? "(pipeline default)"}`,
    "writes_when_executed:",
    "- create the output directory",
    "- create or update the CLI local user in the configured database",
    "- store the source video through the configured storage backend",
    "- create a database project for the imported video",
    "- process evidence, generate steps, and export steps.json unless --dry-run is set",
  ];

  if (options.dryRun) {
    lines.push(
      "dry_run_note: existing --dry-run still creates the CLI user, stores the source video, and creates a database project before skipping processing.",
    );
  }

  return lines;
}

function printUsage(): void {
  console.log(`Usage:
  pnpm tsx server/cli/generatePipeline.ts --video ./demo.mp4 --outdir ./outputs \\
    [--use-audio true|false] [--asr-provider none|openai|local_whisper] \\
    [--ocr-provider none|llm] [--cache-dir ./data/cache] [--threshold 5] \\
    [--min-interval 30] [--max-frames 100] [--debug] [--dry-run] [--preflight]`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options.video) {
    printUsage();
    throw new Error("--video is required");
  }

  if (options.preflight) {
    await fs.access(options.video);
    console.log(buildPreflightLines(options, "PASS").join("\n"));
    return;
  }

  if (options.cacheDir) {
    process.env.PIPELINE_CACHE_DIR = options.cacheDir;
  }
  if (options.asrProvider) {
    process.env.ASR_PROVIDER = options.asrProvider;
  } else if (!options.useAudio) {
    process.env.ASR_PROVIDER = "none";
  }
  if (options.ocrProvider) {
    process.env.OCR_PROVIDER = options.ocrProvider;
  }

  if (options.debug) {
    process.env.LOG_LEVEL = "debug";
  }

  const [
    db,
    { processVideo },
    { generateStepsForProject },
    { loadStepsArtifact },
    { storagePut },
  ] = await Promise.all([
    import("../db"),
    import("../videoProcessor"),
    import("../stepGenerator"),
    import("../stepsArtifact"),
    import("../storage"),
  ]);

  await fs.mkdir(options.outdir, { recursive: true });

  const openId = process.env.DEV_USER_OPEN_ID ?? "cli-local-user";
  await db.upsertUser({
    openId,
    name: process.env.DEV_USER_NAME ?? "CLI Local User",
    email: process.env.DEV_USER_EMAIL ?? null,
    loginMethod: "local-cli",
  });
  const user = await db.getUserByOpenId(openId);
  if (!user) {
    throw new Error("Failed to create or load CLI user");
  }

  const videoBuffer = await fs.readFile(options.video);
  const fileName = path.basename(options.video);
  const videoKey = `projects/${user.id}/videos/${Date.now()}_${fileName}`;
  const { url: videoUrl } = await storagePut(videoKey, videoBuffer, "video/mp4");

  const projectId = await db.createProject({
    userId: user.id,
    title: `CLI Import: ${fileName}`,
    description: "Generated from CLI",
    videoUrl,
    videoKey,
    status: "uploading",
  });

  console.log(`Created project: ${projectId}`);
  if (options.dryRun) {
    console.log("Dry run enabled; skipping processing.");
    return;
  }

  await db.updateProjectStatus(projectId, "processing");

  await processVideo(projectId, videoUrl, videoKey, {
    threshold: options.threshold,
    minInterval: options.minInterval,
    maxFrames: options.maxFrames,
  });

  await generateStepsForProject(projectId);

  const artifact = await loadStepsArtifact(projectId);
  if (!artifact) {
    throw new Error("steps.json was not generated");
  }

  const outputPath = path.join(options.outdir, `project_${projectId}_steps.json`);
  await fs.writeFile(outputPath, JSON.stringify(artifact, null, 2), "utf8");
  console.log(`steps.json exported: ${outputPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main()
    .then(async () => {
      const { getSharedOcrEngine } = await import("../_core/ocrEngine");
      await getSharedOcrEngine().shutdown();
      process.exit(0);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
