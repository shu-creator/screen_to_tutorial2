#!/usr/bin/env tsx
import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import { pathToFileURL } from "url";

export const repoRoot = path.resolve(import.meta.dirname, "..");
const defaultCaseId = "real-app-workflow-03-generate-steps";

export type PromptCheckOptions = {
  caseId: string;
  runId: string;
  root: string;
  useAudio: string;
  asrProvider: string;
  ocrProvider?: string;
  threshold?: string;
  minInterval?: string;
  maxFrames?: string;
  execute: boolean;
  acceptSideEffects: boolean;
};

export type PromptCheckPlan = {
  caseId: string;
  videoPath: string;
  outdir: string;
  sideEffects: string[];
  preflightCommand: string[];
  executeCommand: string[];
  evalStepsPathTemplate: string;
  evalCommandTemplate: string;
};

export function parseArgs(argv: string[]): PromptCheckOptions {
  const options: PromptCheckOptions = {
    caseId: defaultCaseId,
    runId: timestamp(),
    root: path.join(repoRoot, "outputs", "post-v1-prompt-check"),
    useAudio: "false",
    asrProvider: "none",
    execute: false,
    acceptSideEffects: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--":
        break;
      case "--case":
        options.caseId = requireNext(arg, next);
        i += 1;
        break;
      case "--run-id":
        options.runId = requireNext(arg, next);
        i += 1;
        break;
      case "--root":
        options.root = path.resolve(process.cwd(), requireNext(arg, next));
        i += 1;
        break;
      case "--use-audio":
        options.useAudio = requireNext(arg, next);
        i += 1;
        break;
      case "--asr-provider":
        options.asrProvider = requireNext(arg, next);
        i += 1;
        break;
      case "--ocr-provider":
        options.ocrProvider = requireNext(arg, next);
        i += 1;
        break;
      case "--threshold":
        options.threshold = requireNext(arg, next);
        i += 1;
        break;
      case "--min-interval":
        options.minInterval = requireNext(arg, next);
        i += 1;
        break;
      case "--max-frames":
        options.maxFrames = requireNext(arg, next);
        i += 1;
        break;
      case "--execute":
        options.execute = true;
        break;
      case "--accept-side-effects":
        options.acceptSideEffects = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  validateCaseId(options.caseId);
  if (!options.runId.trim()) throw new Error("--run-id must not be empty");
  return options;
}

export function buildPromptCheckPlan(options: PromptCheckOptions): PromptCheckPlan {
  const videoPath = path.join(repoRoot, "eval", "dataset", options.caseId, "video.mp4");
  const outdir = path.join(path.resolve(options.root), `${options.caseId}-run-${options.runId}`);
  const pipelineArgs = [
    "pipeline:generate",
    "--",
    "--video",
    videoPath,
    "--outdir",
    outdir,
    "--use-audio",
    options.useAudio,
    "--asr-provider",
    options.asrProvider,
  ];

  appendOptionalPipelineArgs(pipelineArgs, options);

  const executeCommand = [...pipelineArgs];
  const preflightCommand = [...pipelineArgs, "--preflight"];
  const evalStepsPathTemplate = `${outdir}/project_<project-id>_steps.json`;
  const evalCommandTemplate = [
    "pnpm",
    "eval:candidate",
    "--",
    "--case",
    shellQuote(options.caseId),
    "--steps",
    shellQuote(evalStepsPathTemplate),
    "--post-v1-promotion-gate",
    "--details",
  ].join(" ");

  return {
    caseId: options.caseId,
    videoPath,
    outdir,
    sideEffects: [
      "create the output directory",
      "create or update CLI user/project state in the configured database",
      "store the source video through the configured storage backend",
      "invoke configured pipeline/authoring providers",
      "write exported project_*_steps.json",
    ],
    preflightCommand,
    executeCommand,
    evalStepsPathTemplate,
    evalCommandTemplate,
  };
}

export function validateExecutionOptions(options: PromptCheckOptions): void {
  if (options.execute && !options.acceptSideEffects) {
    throw new Error("--execute requires --accept-side-effects");
  }
  if (!options.execute && options.acceptSideEffects) {
    throw new Error("--accept-side-effects requires --execute");
  }
}

export function formatPlan(plan: PromptCheckPlan, execute: boolean): string {
  const lines = [
    execute ? "Post-v1 prompt check: execute" : "Post-v1 prompt check: plan only (no writes)",
    `case: ${plan.caseId}`,
    `video: ${plan.videoPath}`,
    `outdir: ${plan.outdir}`,
    "",
    "Preflight command:",
    `pnpm ${shellJoin(plan.preflightCommand)}`,
    "",
    "Execution side effects:",
    ...plan.sideEffects.map((effect) => `- ${effect}`),
    "",
    "Execution command:",
    `pnpm ${shellJoin(plan.executeCommand)}`,
    "",
    "Promotion gate command after generation:",
    plan.evalCommandTemplate,
    "# replace <project-id> with the actual generated project id, or use --execute to resolve it automatically",
  ];
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  validateExecutionOptions(options);
  const plan = buildPromptCheckPlan(options);

  if (!options.execute) {
    console.log(formatPlan(plan, false));
    return;
  }

  console.log(formatPlan(plan, true));
  await runPnpm(plan.executeCommand);
  const stepsPath = await findSingleStepsArtifact(plan.outdir);
  await runPnpm([
    "eval:candidate",
    "--",
    "--case",
    options.caseId,
    "--steps",
    stepsPath,
    "--post-v1-promotion-gate",
    "--details",
  ]);
}

function appendOptionalPipelineArgs(args: string[], options: PromptCheckOptions): void {
  if (options.ocrProvider) args.push("--ocr-provider", options.ocrProvider);
  if (options.threshold) args.push("--threshold", options.threshold);
  if (options.minInterval) args.push("--min-interval", options.minInterval);
  if (options.maxFrames) args.push("--max-frames", options.maxFrames);
}

async function findSingleStepsArtifact(outdir: string): Promise<string> {
  let entries: string[];
  try {
    entries = await fs.readdir(outdir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read output directory ${outdir}: ${message}`);
  }
  const matches = entries
    .filter((entry) => /^project_[^/]+_steps\.json$/.test(entry))
    .map((entry) => path.join(outdir, entry));
  if (matches.length !== 1) {
    throw new Error(`expected exactly one project_*_steps.json in ${outdir}, found ${matches.length}`);
  }
  return matches[0];
}

async function runPnpm(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pnpm", args, {
      cwd: repoRoot,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pnpm ${shellJoin(args)} failed with exit code ${code}`));
    });
  });
}

function timestamp(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function validateCaseId(caseId: string): void {
  if (!caseId.trim()) throw new Error("--case must not be empty");
  if (/[/\\]/.test(caseId)) throw new Error(`--case must not contain path separators: ${caseId}`);
  if (caseId === "." || caseId === "..") throw new Error(`--case must not be a directory reference: ${caseId}`);
}

function requireNext(arg: string, next: string | undefined): string {
  if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
  return next;
}

function shellJoin(args: string[]): string {
  return args.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function printUsage(): void {
  console.log(`Usage:
  pnpm post-v1:prompt-check
  pnpm post-v1:prompt-check -- --execute --accept-side-effects

Options:
  --case <case-id>             Default: ${defaultCaseId}
  --run-id <id>                Default: current timestamp
  --root <dir>                 Default: outputs/post-v1-prompt-check
  --use-audio <true|false>     Passed to pipeline:generate. Default: false
  --asr-provider <value>       Passed to pipeline:generate. Default: none
  --ocr-provider <value>       Optional pipeline OCR provider
  --threshold <value>          Optional frame threshold
  --min-interval <value>       Optional min interval
  --max-frames <value>         Optional max frames
  --execute                    Run the side-effecting generation and promotion gate
  --accept-side-effects        Required with --execute

Default mode prints a no-write plan only.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
