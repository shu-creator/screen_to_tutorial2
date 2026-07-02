#!/usr/bin/env node
import "dotenv/config";
import { execFile } from "child_process";
import fs from "fs/promises";
import path from "path";
import { promisify } from "util";
import { pathToFileURL } from "url";

const execFileAsync = promisify(execFile);

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

type PreflightStatus = "PASS" | "PLAN" | "FAIL";
type PreflightCheckStatus = "PASS" | "WARN" | "FAIL";

export type PreflightCheck = {
  status: PreflightCheckStatus;
  code: string;
  message: string;
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

function effectiveAuthoringProvider(
  env: NodeJS.ProcessEnv = process.env
): string {
  return env.AUTHORING_PROVIDER ?? "llm";
}

function effectiveAsrProvider(
  options: CliOptions,
  env: NodeJS.ProcessEnv = process.env
): string {
  return options.asrProvider ?? (!options.useAudio ? "none" : env.ASR_PROVIDER ?? "none");
}

function effectiveOcrProvider(
  options: CliOptions,
  env: NodeJS.ProcessEnv = process.env
): string {
  return options.ocrProvider ?? env.OCR_PROVIDER ?? "llm";
}

function effectiveOcrEngineFallback(
  env: NodeJS.ProcessEnv = process.env
): string {
  return env.OCR_ENGINE_FALLBACK ?? "llm";
}

export function buildPreflightChecks(
  options: CliOptions,
  env: NodeJS.ProcessEnv = process.env
): PreflightCheck[] {
  const authoringProvider = effectiveAuthoringProvider(env);
  const asrProvider = effectiveAsrProvider(options, env);
  const ocrProvider = effectiveOcrProvider(options, env);
  const ocrEngineFallback = effectiveOcrEngineFallback(env);
  const ttsProvider = env.TTS_PROVIDER ?? "openai";
  const codexModel = (env.CODEX_MODEL ?? "").trim();
  const checks: PreflightCheck[] = [];

  if (authoringProvider !== "codex_app_server") {
    checks.push({
      status: "PASS",
      code: "authoring_provider",
      message: `using ${authoringProvider}; Codex App Server authoring is not active`,
    });
    return checks;
  }

  checks.push({
    status: "PASS",
    code: "authoring_provider",
    message:
      "codex_app_server active; legacy frame LLM authoring is disabled when evidence is missing",
  });

  checks.push({
    status: "PASS",
    code: "evidence_required",
    message:
      "pipeline execution must produce evidence.json before step authoring; no legacy frame LLM fallback will be used",
  });

  if (asrProvider === "none") {
    checks.push({
      status: "PASS",
      code: "asr_provider",
      message: "ASR_PROVIDER=none is within the Codex API-free scope",
    });
  } else if (asrProvider === "local_whisper") {
    checks.push({
      status: "PASS",
      code: "asr_provider",
      message:
        "ASR_PROVIDER=local_whisper uses the local whisper CLI and is within the Codex API-free scope",
    });
  } else {
    checks.push({
      status: "FAIL",
      code: "asr_provider",
      message: `ASR provider ${asrProvider} is outside the Codex API-free scope; use --asr-provider none or --asr-provider local_whisper`,
    });
  }

  if (ocrProvider === "engine") {
    checks.push({
      status: "PASS",
      code: "ocr_provider",
      message: "OCR_PROVIDER=engine avoids LLM OCR in the authoring experiment",
    });
    if (ocrEngineFallback === "none") {
      checks.push({
        status: "PASS",
        code: "ocr_engine_fallback",
        message:
          "OCR_ENGINE_FALLBACK=none keeps engine OCR failures API-free by recording empty OCR evidence with a warning",
      });
    } else {
      checks.push({
        status: "FAIL",
        code: "ocr_engine_fallback",
        message:
          "OCR_ENGINE_FALLBACK=llm leaves LLM-OCR fallback enabled, so this run is not strictly API-free; set OCR_ENGINE_FALLBACK=none",
      });
    }
  } else {
    checks.push({
      status: "FAIL",
      code: "ocr_provider",
      message: `OCR provider ${ocrProvider} can call API-backed OCR or skip evidence labels; use --ocr-provider engine`,
    });
  }

  if (ttsProvider === "none") {
    checks.push({
      status: "FAIL",
      code: "tts_provider",
      message:
        "TTS_PROVIDER=none is not supported by ENV yet; pipeline:generate does not synthesize TTS, so leave TTS_PROVIDER=openai|gemini for this slice",
    });
  } else {
    checks.push({
      status: "PASS",
      code: "tts_provider",
      message:
        "TTS is not invoked by pipeline:generate; OCR/ASR/TTS replacement remains out of scope",
    });
  }

  if (codexModel.length > 0) {
    checks.push({
      status: "PASS",
      code: "codex_model",
      message: `CODEX_MODEL=${codexModel}; used for the Codex app-server model override and authoring cache key`,
    });
  } else {
    checks.push({
      status: "WARN",
      code: "codex_model",
      message:
        "CODEX_MODEL is unset; Codex authoring cache is disabled to avoid stale cache collisions",
    });
  }

  return checks;
}

async function checkLocalOcrEngineDependencies(
  env: NodeJS.ProcessEnv,
): Promise<PreflightCheck> {
  const pythonBin = env.OCR_PYTHON_BIN ?? "python3";
  const probe = [
    "import importlib.util, shutil, sys",
    "missing = []",
    "if importlib.util.find_spec('PIL') is None:",
    "    missing.append('Pillow')",
    "has_paddle = importlib.util.find_spec('paddleocr') is not None",
    "has_tesseract = shutil.which('tesseract') is not None",
    "if missing or not (has_paddle or has_tesseract):",
    "    details = []",
    "    if missing:",
    "        details.append('missing Python modules: ' + ', '.join(missing))",
    "    if not (has_paddle or has_tesseract):",
    "        details.append('missing OCR engine: install paddleocr/paddlepaddle or tesseract')",
    "    print('; '.join(details), file=sys.stderr)",
    "    sys.exit(2)",
    "print('ok')",
  ].join("\n");

  try {
    await execFileAsync(pythonBin, ["-c", probe], { timeout: 10_000, env });
    return {
      status: "PASS",
      code: "ocr_engine_dependencies",
      message: `OCR_PYTHON_BIN=${pythonBin} can import PIL and find PaddleOCR or tesseract`,
    };
  } catch (error) {
    const execError = error as {
      stderr?: unknown;
      message?: unknown;
    };
    const stderr =
      typeof execError.stderr === "string" ? execError.stderr.trim() : "";
    const message =
      typeof execError.message === "string" ? execError.message : String(error);
    return {
      status: "FAIL",
      code: "ocr_engine_dependencies",
      message:
        `OCR_PROVIDER=engine requires local OCR dependencies via OCR_PYTHON_BIN=${pythonBin}. ` +
        "Prepare a project .venv and install dependencies, for example: python3 -m venv .venv; .venv/bin/pip install pillow paddlepaddle paddleocr. " +
        `Check failed: ${stderr || message}`,
    };
  }
}

export async function collectPreflightChecks(
  options: CliOptions,
  env: NodeJS.ProcessEnv = process.env
): Promise<PreflightCheck[]> {
  const checks = buildPreflightChecks(options, env);
  const asrProvider = effectiveAsrProvider(options, env);
  const ocrProvider = effectiveOcrProvider(options, env);

  if (options.video) {
    try {
      await fs.access(options.video);
      checks.push({
        status: "PASS",
        code: "video",
        message: "input video is readable",
      });
    } catch (error) {
      checks.push({
        status: "FAIL",
        code: "video",
        message: `input video is not readable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  if (effectiveAuthoringProvider(env) === "codex_app_server") {
    if (ocrProvider === "engine") {
      checks.push(await checkLocalOcrEngineDependencies(env));
    }

    if (asrProvider === "local_whisper") {
      try {
        await execFileAsync("whisper", ["--help"], { timeout: 10_000, env });
        checks.push({
          status: "PASS",
          code: "asr_local_whisper_cli",
          message: "whisper CLI is available for ASR_PROVIDER=local_whisper",
        });
      } catch (error) {
        const execError = error as { message?: unknown };
        checks.push({
          status: "FAIL",
          code: "asr_local_whisper_cli",
          message: `whisper CLI is required for ASR_PROVIDER=local_whisper; install Python openai-whisper first, for example with pip install openai-whisper. Check failed: ${
            typeof execError.message === "string"
              ? execError.message
              : String(error)
          }`,
        });
      }
    }

    let helpText = "";
    try {
      const { stdout, stderr } = await execFileAsync(
        "codex",
        ["app-server", "--help"],
        { timeout: 10_000, env }
      );
      helpText = `${stdout}\n${stderr}`;
    } catch (error) {
      const execError = error as {
        stdout?: unknown;
        stderr?: unknown;
        message?: unknown;
      };
      const stdout =
        typeof execError.stdout === "string" ? execError.stdout : "";
      const stderr =
        typeof execError.stderr === "string" ? execError.stderr : "";
      helpText = `${stdout}\n${stderr}`;
      if (helpText.trim().length === 0) {
        checks.push({
          status: "FAIL",
          code: "codex_app_server_cli",
          message: `codex app-server --help failed: ${
            typeof execError.message === "string"
              ? execError.message
              : String(error)
          }`,
        });
        return checks;
      }
    }
    const supportsStdio =
      helpText.includes("--listen") && helpText.includes("stdio://");
    checks.push({
      status: supportsStdio ? "PASS" : "FAIL",
      code: "codex_app_server_cli",
      message: supportsStdio
        ? "codex app-server supports --listen stdio://"
        : "codex app-server help did not advertise --listen stdio://",
    });
  }

  return checks;
}

function preflightStatusFromChecks(checks: PreflightCheck[]): "PASS" | "FAIL" {
  return checks.some(check => check.status === "FAIL") ? "FAIL" : "PASS";
}

export function buildPreflightLines(
  options: CliOptions,
  status: PreflightStatus = "PLAN",
  checks: PreflightCheck[] | undefined = undefined,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const resolvedChecks = checks ?? buildPreflightChecks(options, env);
  const videoPath = options.video
    ? path.resolve(process.cwd(), options.video)
    : "(missing)";
  const asrProvider =
    options.asrProvider ?? (!options.useAudio ? "none" : env.ASR_PROVIDER);
  const ocrProvider = options.ocrProvider ?? env.OCR_PROVIDER;
  const authoringProvider = env.AUTHORING_PROVIDER ?? "llm";
  const ocrEngineFallback = env.OCR_ENGINE_FALLBACK ?? "llm";
  const lines = [
    `Pipeline preflight: ${status}`,
    `video: ${videoPath}`,
    `outdir: ${options.outdir}`,
    `use_audio: ${options.useAudio}`,
    `authoring_provider: ${describeProvider(authoringProvider)}`,
    `asr_provider: ${describeProvider(asrProvider)}`,
    `ocr_provider: ${describeProvider(ocrProvider)}`,
    `ocr_engine_fallback: ${describeProvider(ocrEngineFallback)}`,
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
    "checks:",
    ...resolvedChecks.map(
      check => `- ${check.status} ${check.code}: ${check.message}`
    ),
  ];

  if (options.dryRun) {
    lines.push(
      "dry_run_note: existing --dry-run still creates the CLI user, stores the source video, and creates a database project before skipping processing."
    );
  }

  return lines;
}

function printUsage(): void {
  console.log(`Usage:
  pnpm tsx server/cli/generatePipeline.ts --video ./demo.mp4 --outdir ./outputs \\
    [--use-audio true|false] [--asr-provider none|openai|local_whisper] \\
    [--ocr-provider none|llm|engine] [--cache-dir ./data/cache] [--threshold 5] \\
    [--min-interval 30] [--max-frames 100] [--debug] [--dry-run] [--preflight]`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options.video) {
    printUsage();
    throw new Error("--video is required");
  }

  if (options.preflight) {
    const checks = await collectPreflightChecks(options);
    const status = preflightStatusFromChecks(checks);
    console.log(buildPreflightLines(options, status, checks).join("\n"));
    if (status === "FAIL") {
      process.exitCode = 1;
    }
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
  const { url: videoUrl } = await storagePut(
    videoKey,
    videoBuffer,
    "video/mp4"
  );

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

  const outputPath = path.join(
    options.outdir,
    `project_${projectId}_steps.json`
  );
  await fs.writeFile(outputPath, JSON.stringify(artifact, null, 2), "utf8");
  console.log(`steps.json exported: ${outputPath}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main()
    .then(async () => {
      const { getSharedOcrEngine } = await import("../_core/ocrEngine");
      await getSharedOcrEngine().shutdown();
      process.exit(process.exitCode ?? 0);
    })
    .catch(error => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
