#!/usr/bin/env tsx
import "dotenv/config";
import { execFile } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

type Options = {
  video?: string;
  outdir: string;
  workdir?: string;
  keepWorkdir: boolean;
  allowInstall: boolean;
  preflightOnly: boolean;
  installMode: "offline" | "online";
  maxFrames?: number;
};

type CommandRecord = {
  command: string;
  cwd: string;
  exit_code: number;
  stdout_tail: string;
  stderr_tail: string;
};

type FreshSmokeSummary = Record<string, unknown> & {
  artifacts?: {
    steps?: string | null;
    export_summary?: string | null;
    edit_smoke_summary?: string | null;
    [key: string]: unknown;
  };
};

export type FreshEnvPreflightFacts = {
  videoExists: boolean;
  trackedWorktreeClean: boolean;
  databaseUrlSet: boolean;
  workdirEmpty: boolean;
  workdirSpecified: boolean;
};

export type FreshEnvPreflightResult = {
  pass: boolean;
  checks: Array<{ name: string; pass: boolean; detail: string }>;
};

const safeOutputsRoot = path.join(repoRoot, "outputs");
const inheritedEnvAllowlist = [
  "LLM_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  "TTS_API_KEY",
];

function parseArgs(argv: string[]): Options {
  const options: Options = {
    outdir: path.join(repoRoot, "outputs", "v1-fresh-env-smoke"),
    keepWorkdir: false,
    allowInstall: false,
    preflightOnly: false,
    installMode: "offline",
    maxFrames: 12,
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
    } else if (arg === "--workdir") {
      if (!next || next.startsWith("--")) throw new Error("--workdir requires a value");
      options.workdir = path.resolve(next);
      i += 1;
    } else if (arg === "--allow-install") {
      options.allowInstall = true;
    } else if (arg === "--preflight-only") {
      options.preflightOnly = true;
    } else if (arg === "--install-mode") {
      if (next !== "offline" && next !== "online") throw new Error("--install-mode requires offline or online");
      options.installMode = next;
      i += 1;
    } else if (arg === "--max-frames") {
      if (!next || next.startsWith("--")) throw new Error("--max-frames requires a value");
      options.maxFrames = Number(next);
      i += 1;
    } else if (arg === "--keep-workdir") {
      options.keepWorkdir = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.video) throw new Error("--video is required");
  if (!options.allowInstall && !options.preflightOnly) {
    throw new Error("--allow-install is required because this command installs dependencies in a temporary checkout");
  }
  if (options.maxFrames !== undefined && (!Number.isInteger(options.maxFrames) || options.maxFrames <= 0)) {
    throw new Error("--max-frames must be a positive integer");
  }
  assertSafeOutdir(options.outdir);
  return options;
}

function printHelp(): void {
  console.log(`Usage:
  pnpm v1:fresh-env-smoke -- --video ./sample.mp4 --allow-install \\
    [--install-mode offline|online] [--outdir ./outputs/v1-fresh-env-smoke] \\
    [--workdir /tmp/screen-to-tutorial-fresh] [--keep-workdir] [--max-frames 12]

  pnpm v1:fresh-env-smoke -- --video ./sample.mp4 --preflight-only

Creates a temporary checkout from HEAD, installs dependencies there, runs v1:smoke,
and copies the resulting fresh-env evidence into the requested outdir.
Use --preflight-only to check prerequisites without creating a checkout or installing dependencies.
`);
}

export function assertSafeOutdir(outdir: string): void {
  if (!outdir.startsWith(`${safeOutputsRoot}${path.sep}`)) {
    throw new Error(`--outdir must be within ${safeOutputsRoot}, got: ${outdir}`);
  }
}

function redactedValues(): string[] {
  return [
    process.env.DATABASE_URL,
    ...inheritedEnvAllowlist.map((key) => process.env[key]),
  ].filter((value): value is string => Boolean(value));
}

function redact(text: string): string {
  let redacted = text;
  for (const value of redactedValues()) {
    redacted = redacted.split(value).join("[REDACTED]");
  }
  return redacted;
}

function tail(text: string): string {
  return redact(text).split("\n").slice(-20).join("\n");
}

export function buildChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? os.homedir(),
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    TEMP: process.env.TEMP,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    NODE_ENV: "development",
  };
  for (const key of inheritedEnvAllowlist) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) as NodeJS.ProcessEnv;
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<CommandRecord> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      env,
      timeout: timeoutMs,
      maxBuffer: 30 * 1024 * 1024,
    });
    const commandText = redact([command, ...args].join(" "));
    return {
      command: commandText,
      cwd: path.relative(repoRoot, cwd) || ".",
      exit_code: 0,
      stdout_tail: tail(stdout),
      stderr_tail: tail(stderr),
    };
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string; code?: number | string };
    const commandText = redact([command, ...args].join(" "));
    return {
      command: commandText,
      cwd: path.relative(repoRoot, cwd) || ".",
      exit_code: typeof failure.code === "number" ? failure.code : 1,
      stdout_tail: tail(failure.stdout ?? ""),
      stderr_tail: tail(failure.stderr ?? failure.message),
    };
  }
}

async function runRequired(
  records: CommandRecord[],
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<CommandRecord> {
  const record = await runCommand(command, args, cwd, timeoutMs, env);
  records.push(record);
  if (record.exit_code !== 0) {
    throw new Error(`${record.command} failed with exit_code=${record.exit_code}`);
  }
  return record;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function writeEnvFile(checkoutDir: string): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set in the parent environment for fresh-env smoke");
  }
  const env = [
    `DATABASE_URL=${databaseUrl}`,
    "AUTH_MODE=none",
    "VITE_AUTH_MODE=none",
    "ALLOW_UNSAFE_AUTH_MODE_NONE=false",
    "LLM_PROVIDER=openai",
    "LLM_MODEL=gpt-5.4",
    "ASR_PROVIDER=none",
    "OCR_PROVIDER=none",
    "STORAGE_DIR=./data/storage",
    "",
  ].join("\n");
  await fs.writeFile(path.join(checkoutDir, ".env"), env, { mode: 0o600 });
}

async function assertTrackedWorktreeClean(): Promise<void> {
  try {
    await execFileAsync("git", ["diff", "--quiet", "HEAD", "--"], { cwd: repoRoot });
    await execFileAsync("git", ["diff", "--cached", "--quiet"], { cwd: repoRoot });
  } catch {
    throw new Error("tracked worktree must be clean before creating fresh-env smoke evidence");
  }
}

export function assessFreshEnvPreflight(facts: FreshEnvPreflightFacts): FreshEnvPreflightResult {
  const workdirDetail = facts.workdirSpecified
    ? facts.workdirEmpty ? "workdir exists and is empty, or does not exist yet" : "workdir exists and is not empty"
    : "workdir not specified; mkdtemp will create a clean directory";
  const checks = [
    { name: "video.exists", pass: facts.videoExists, detail: facts.videoExists ? "input video exists" : "input video is missing" },
    { name: "worktree.clean", pass: facts.trackedWorktreeClean, detail: facts.trackedWorktreeClean ? "tracked worktree is clean" : "tracked worktree is not clean, or git clean-state check failed" },
    { name: "database_url.set", pass: facts.databaseUrlSet, detail: facts.databaseUrlSet ? "DATABASE_URL is set" : "DATABASE_URL is missing" },
    { name: "workdir.empty", pass: facts.workdirEmpty, detail: workdirDetail },
  ];
  return { pass: checks.every((check) => check.pass), checks };
}

async function trackedWorktreeClean(): Promise<boolean> {
  try {
    await assertTrackedWorktreeClean();
    return true;
  } catch {
    return false;
  }
}

async function workdirEmpty(workdir: string | undefined): Promise<boolean> {
  if (!workdir) return true;
  try {
    const entries = await fs.readdir(workdir);
    return entries.length === 0;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function collectFreshEnvPreflightFacts(options: Options): Promise<FreshEnvPreflightFacts> {
  return {
    videoExists: await fs.access(options.video as string).then(() => true, () => false),
    trackedWorktreeClean: await trackedWorktreeClean(),
    databaseUrlSet: Boolean(process.env.DATABASE_URL),
    workdirEmpty: await workdirEmpty(options.workdir),
    workdirSpecified: Boolean(options.workdir),
  };
}

function printFreshEnvPreflight(result: FreshEnvPreflightResult): void {
  console.log(`fresh env smoke preflight: ${result.pass ? "PASS" : "FAIL"}`);
  for (const check of result.checks) {
    console.log(`${check.pass ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  }
}

export function rewriteFreshSummaryArtifactPaths(summary: FreshSmokeSummary, outdir: string): FreshSmokeSummary {
  if (!summary.artifacts) return summary;
  const rewrite = (artifactPath: string | null | undefined, subdir: string): string | null | undefined => {
    if (!artifactPath) return artifactPath;
    return path.relative(repoRoot, path.join(outdir, subdir, path.basename(artifactPath)));
  };
  return {
    ...summary,
    artifacts: {
      ...summary.artifacts,
      steps: rewrite(summary.artifacts.steps, "pipeline"),
      export_summary: rewrite(summary.artifacts.export_summary, "project-export"),
      edit_smoke_summary: rewrite(summary.artifacts.edit_smoke_summary, "edit-smoke"),
    },
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.preflightOnly) {
    const result = assessFreshEnvPreflight(await collectFreshEnvPreflightFacts(options));
    printFreshEnvPreflight(result);
    if (!result.pass) process.exit(1);
    return;
  }
  const videoPath = options.video as string;
  const commands: CommandRecord[] = [];
  const childEnv = buildChildEnv();
  await assertTrackedWorktreeClean();
  const sourceCommit = (await runRequired(commands, "git", ["rev-parse", "HEAD"], repoRoot, 10_000, childEnv)).stdout_tail.trim();
  const createdTempWorkdir = !options.workdir;
  const workdir = options.workdir ?? await fs.mkdtemp(path.join(os.tmpdir(), "screen-to-tutorial-fresh-"));
  const checkoutDir = path.join(workdir, "checkout");
  const archivePath = path.join(workdir, "repo.tar");
  const freshOutdir = path.join(checkoutDir, "outputs", "v1-fresh-env-smoke");
  const copiedVideo = path.join(checkoutDir, "sample-video.mp4");

  await fs.mkdir(workdir, { recursive: true });
  if (!createdTempWorkdir) {
    const entries = await fs.readdir(workdir);
    if (entries.length > 0) {
      throw new Error(`--workdir must be empty: ${workdir}`);
    }
  }
  await fs.mkdir(checkoutDir, { recursive: true });

  try {
    await runRequired(commands, "git", ["archive", "--format=tar", "-o", archivePath, "HEAD"], repoRoot, 60_000, childEnv);
    await runRequired(commands, "tar", ["-xf", archivePath, "-C", checkoutDir], repoRoot, 60_000, childEnv);
    await fs.copyFile(videoPath, copiedVideo);
    await writeEnvFile(checkoutDir);

    const installArgs = ["install", "--frozen-lockfile"];
    if (options.installMode === "offline") installArgs.push("--offline");
    await runRequired(commands, "pnpm", installArgs, checkoutDir, 10 * 60_000, childEnv);

    const smokeArgs = [
      "v1:smoke",
      "--",
      "--video",
      copiedVideo,
      "--outdir",
      freshOutdir,
      "--use-audio",
      "false",
      "--asr-provider",
      "none",
      "--ocr-provider",
      "none",
      "--audio-mode",
      "silent",
    ];
    if (options.maxFrames !== undefined) smokeArgs.push("--max-frames", String(options.maxFrames));
    await runRequired(commands, "pnpm", smokeArgs, checkoutDir, 30 * 60_000, childEnv);

    await fs.rm(options.outdir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(options.outdir), { recursive: true });
    await fs.cp(freshOutdir, options.outdir, { recursive: true });

    const summaryPath = path.join(options.outdir, "v1_smoke_summary.json");
    const summary = rewriteFreshSummaryArtifactPaths(await readJson<FreshSmokeSummary>(summaryPath), options.outdir);
    summary.environment = {
      kind: "fresh_checkout",
      source_commit: sourceCommit,
      dependency_install: {
        command: `pnpm ${installArgs.join(" ")}`,
        mode: options.installMode,
      },
      inherited_parent_env_vars: inheritedEnvAllowlist.filter((key) => Boolean(process.env[key])),
      checkout_created_from: "git archive HEAD",
      copied_input_video: path.relative(repoRoot, videoPath),
      workdir: options.keepWorkdir ? workdir : null,
    };
    summary.fresh_env_commands = commands;
    await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

    console.log(`fresh env smoke summary: ${path.relative(repoRoot, summaryPath)}`);
  } finally {
    if (!options.keepWorkdir && createdTempWorkdir) {
      await fs.rm(workdir, { recursive: true, force: true });
    } else if (!options.keepWorkdir) {
      await fs.rm(checkoutDir, { recursive: true, force: true });
      await fs.rm(archivePath, { force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
