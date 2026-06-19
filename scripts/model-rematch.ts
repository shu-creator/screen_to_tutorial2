#!/usr/bin/env tsx
import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import { pathToFileURL } from "url";

type RunRecord = {
  model: string;
  runIndex: number;
  runId: string;
  outDir: string;
  cacheDir: string;
  stepsPath?: string;
  evalResultPath?: string;
  status: "passed" | "invalid" | "failed";
  error?: string;
  stepCount?: number;
  needsReviewCount?: number;
  fallbackSuspected?: boolean;
  invalidReasons?: string[];
  metrics?: {
    g1F1?: number;
    g2Accuracy?: number;
    g2NoCitationRate?: number;
    g3Rate?: number;
    boundaryRecall?: number;
  };
};

type CliOptions = {
  caseId: string;
  models: string[];
  runs: number;
  root: string;
  ocrProvider: string;
  useAudio: string;
  asrProvider: string;
  threshold?: string;
  minInterval?: string;
  maxFrames?: string;
  fallbackThreshold: number;
  continueOnFailure: boolean;
  dryRun: boolean;
  regenerateSummary: boolean;
};

const repoRoot = path.resolve(import.meta.dirname, "..");

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    caseId: "real-app-workflow-01",
    models: ["gpt-5.4", "gpt-5.5"],
    runs: 2,
    root: path.join(repoRoot, "eval", "results", "rematch"),
    ocrProvider: "llm",
    useAudio: "false",
    asrProvider: "none",
    fallbackThreshold: 0.8,
    continueOnFailure: true,
    dryRun: false,
    regenerateSummary: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--case":
        options.caseId = requireNext(arg, next);
        i++;
        break;
      case "--models":
        options.models = requireNext(arg, next).split(",").map((m) => m.trim()).filter(Boolean);
        i++;
        break;
      case "--runs":
        options.runs = Number(requireNext(arg, next));
        i++;
        break;
      case "--root":
        options.root = path.resolve(process.cwd(), requireNext(arg, next));
        i++;
        break;
      case "--ocr-provider":
        options.ocrProvider = requireNext(arg, next);
        i++;
        break;
      case "--use-audio":
        options.useAudio = requireNext(arg, next);
        i++;
        break;
      case "--asr-provider":
        options.asrProvider = requireNext(arg, next);
        i++;
        break;
      case "--threshold":
        options.threshold = requireNext(arg, next);
        i++;
        break;
      case "--min-interval":
        options.minInterval = requireNext(arg, next);
        i++;
        break;
      case "--max-frames":
        options.maxFrames = requireNext(arg, next);
        i++;
        break;
      case "--fallback-threshold":
        options.fallbackThreshold = Number(requireNext(arg, next));
        i++;
        break;
      case "--fail-fast":
        options.continueOnFailure = false;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--regenerate-summary":
        options.regenerateSummary = true;
        break;
      case "--help":
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!Number.isInteger(options.runs) || options.runs < 1) {
    throw new Error("--runs must be a positive integer");
  }
  if (options.models.length === 0) {
    throw new Error("--models must contain at least one model");
  }
  if (!Number.isFinite(options.fallbackThreshold) || options.fallbackThreshold < 0 || options.fallbackThreshold > 1) {
    throw new Error("--fallback-threshold must be a number from 0 to 1");
  }
  return options;
}

function requireNext(arg: string, next: string | undefined): string {
  if (!next || next.startsWith("--")) {
    throw new Error(`${arg} requires a value`);
  }
  return next;
}

function printUsage(): void {
  console.log(`Usage:
  pnpm tsx scripts/model-rematch.ts
  pnpm tsx scripts/model-rematch.ts --case real-app-workflow-01 --models gpt-5.4,gpt-5.5 --runs 2

Options:
  --root <dir>            Output root. Default: eval/results/rematch
  --ocr-provider <value>  Passed to pipeline:generate. Default: llm
  --use-audio <value>     Passed to pipeline:generate. Default: false
  --asr-provider <value>  Passed to pipeline:generate. Default: none
  --threshold <value>     Optional frame threshold
  --min-interval <value>  Optional min interval
  --max-frames <value>    Optional max frames
  --fallback-threshold <n> Mark runs invalid when needs_review ratio is above n. Default: 0.8
  --fail-fast             Stop on the first failed run
  --dry-run               Print the run plan without calling the pipeline or API
  --regenerate-summary    Rebuild summary from existing run artifacts without calling the pipeline or API`);
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; logPath: string },
): Promise<{ stdout: string; stderr: string }> {
  await fs.mkdir(path.dirname(options.logPath), { recursive: true });
  const log = await fs.open(options.logPath, "a");
  const startedAt = new Date().toISOString();
  await log.write(`\n$ ${command} ${args.map(shellQuote).join(" ")}\n# started_at=${startedAt}\n`);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
      void log.write(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
      void log.write(text);
    });
    child.on("error", async (error) => {
      await log.write(`# spawn_error=${error.message}\n`);
      await log.close();
      reject(error);
    });
    child.on("close", async (code) => {
      await log.write(`# finished_at=${new Date().toISOString()} exit_code=${code}\n`);
      await log.close();
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} exited with ${code}`));
      }
    });
  });
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=,@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function latestJsonFile(dir: string): Promise<string | null> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const filePath = path.join(dir, entry.name);
        const stat = await fs.stat(filePath);
        return { filePath, mtimeMs: stat.mtimeMs };
      }),
  );
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0]?.filePath ?? null;
}

async function findStepsFile(outDir: string, copyStable = true): Promise<string> {
  const entries = await fs.readdir(outDir, { withFileTypes: true });
  const stablePath = path.join(outDir, "steps.json");
  if (entries.some((entry) => entry.isFile() && entry.name === "steps.json")) {
    return stablePath;
  }
  const candidates = entries
    .filter((entry) => entry.isFile() && /^project_\d+_steps\.json$/.test(entry.name))
    .map((entry) => path.join(outDir, entry.name));
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one project_*_steps.json in ${outDir}, found ${candidates.length}`);
  }
  if (!copyStable) return candidates[0];
  await fs.copyFile(candidates[0], stablePath);
  return stablePath;
}

export async function readStepStats(stepsPath: string, fallbackThreshold: number): Promise<{
  stepCount: number;
  needsReviewCount: number;
  fallbackSuspected: boolean;
}> {
  const raw = JSON.parse(await fs.readFile(stepsPath, "utf8")) as {
    steps?: Array<{ needs_review?: boolean }>;
  };
  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  const needsReviewCount = steps.filter((step) => step.needs_review).length;
  return {
    stepCount: steps.length,
    needsReviewCount,
    fallbackSuspected: steps.length > 0 && needsReviewCount / steps.length > fallbackThreshold,
  };
}

async function readMetrics(evalResultPath: string, caseId: string): Promise<RunRecord["metrics"]> {
  const raw = JSON.parse(await fs.readFile(evalResultPath, "utf8")) as {
    results?: Array<{
      caseId: string;
      g1?: { f1: number };
      g2?: { accuracy: number; noCitationRate: number };
      g3?: { rate: number };
      boundaryRecall?: { recall: number };
    }>;
  };
  const result = raw.results?.find((entry) => entry.caseId === caseId);
  if (!result) return undefined;
  return {
    g1F1: result.g1?.f1,
    g2Accuracy: result.g2?.accuracy,
    g2NoCitationRate: result.g2?.noCitationRate,
    g3Rate: result.g3?.rate,
    boundaryRecall: result.boundaryRecall?.recall,
  };
}

export async function readLogSignals(logPath: string): Promise<string[]> {
  const text = await fs.readFile(logPath, "utf8").catch(() => "");
  const signals: string[] = [];
  if (/LLM invoke failed/i.test(text)) signals.push("llm_invoke_failed");
  if (/(?:LLM invoke failed|HTTP|status|error|code)[^\n]{0,120}\b520\b/i.test(text)) signals.push("openai_520");
  if (/(?:LLM invoke failed|HTTP|status|error|code)[^\n]{0,120}\b429\b/i.test(text)) signals.push("openai_429");
  if (/insufficient_quota/i.test(text)) signals.push("insufficient_quota");
  return signals;
}

export function detectInvalidReasons(record: RunRecord, logSignals: string[]): string[] {
  const reasons: string[] = [];
  if (record.stepCount === 0) reasons.push("zero_steps");
  if (record.fallbackSuspected) reasons.push("all_or_most_steps_need_review");
  if ((record.metrics?.g2Accuracy ?? 1) < 0.01 && (record.metrics?.g2NoCitationRate ?? 0) >= 0.9) {
    reasons.push("g2_zero_with_no_citations");
  }
  reasons.push(...logSignals);
  return Array.from(new Set(reasons));
}

function average(values: Array<number | undefined>): number | undefined {
  const finite = values.filter((value): value is number => Number.isFinite(value));
  if (finite.length === 0) return undefined;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function stdev(values: Array<number | undefined>): number | undefined {
  const finite = values.filter((value): value is number => Number.isFinite(value));
  if (finite.length < 2) return 0;
  const avg = average(finite);
  if (avg === undefined) return undefined;
  const variance = finite.reduce((sum, value) => sum + (value - avg) ** 2, 0) / finite.length;
  return Math.sqrt(variance);
}

function pct(value: number | undefined): string {
  return value === undefined ? "-" : `${(value * 100).toFixed(1)}%`;
}

async function writeSummary(root: string, records: RunRecord[]): Promise<void> {
  const byModel = new Map<string, RunRecord[]>();
  for (const record of records) {
    const list = byModel.get(record.model) ?? [];
    list.push(record);
    byModel.set(record.model, list);
  }

  const rows = Array.from(byModel.entries()).map(([model, modelRecords]) => {
    const passed = modelRecords.filter((record) => record.status === "passed");
    return {
      model,
      runs: modelRecords.length,
      passed: passed.length,
      g1F1Avg: average(passed.map((record) => record.metrics?.g1F1)),
      g1F1Stdev: stdev(passed.map((record) => record.metrics?.g1F1)),
      g2AccuracyAvg: average(passed.map((record) => record.metrics?.g2Accuracy)),
      g2AccuracyStdev: stdev(passed.map((record) => record.metrics?.g2Accuracy)),
      g3RateAvg: average(passed.map((record) => record.metrics?.g3Rate)),
      g3RateStdev: stdev(passed.map((record) => record.metrics?.g3Rate)),
      boundaryRecallAvg: average(passed.map((record) => record.metrics?.boundaryRecall)),
      boundaryRecallStdev: stdev(passed.map((record) => record.metrics?.boundaryRecall)),
    };
  });

  const markdown = [
    "# Model Rematch Summary",
    "",
    `Generated at: ${new Date().toISOString()}`,
    "",
    "| model | passed/runs | G1-F1 avg | G1-F1 sd | G2 acc avg | G2 acc sd | G3 avg | G3 sd | boundary avg | boundary sd |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...rows.map((row) =>
      [
        row.model,
        `${row.passed}/${row.runs}`,
        pct(row.g1F1Avg),
        pct(row.g1F1Stdev),
        pct(row.g2AccuracyAvg),
        pct(row.g2AccuracyStdev),
        pct(row.g3RateAvg),
        pct(row.g3RateStdev),
        pct(row.boundaryRecallAvg),
        pct(row.boundaryRecallStdev),
      ].join(" | "),
    ).map((line) => `| ${line} |`),
    "",
    "## Runs",
    "",
    "| run | model | status | step count | needs review | fallback? | G1-F1 | G2 acc | G2 no citation | G3 | boundary | steps | eval |",
    "|---|---|---|---:|---:|---|---:|---:|---:|---:|---:|---|---|",
    ...records.map((record) =>
      [
        record.runId,
        record.model,
        record.status,
        record.stepCount ?? "-",
        record.needsReviewCount ?? "-",
        record.fallbackSuspected ? "yes" : "no",
        pct(record.metrics?.g1F1),
        pct(record.metrics?.g2Accuracy),
        pct(record.metrics?.g2NoCitationRate),
        pct(record.metrics?.g3Rate),
        pct(record.metrics?.boundaryRecall),
        record.stepsPath ? path.relative(root, record.stepsPath) : "-",
        record.evalResultPath ? path.relative(root, record.evalResultPath) : "-",
      ].join(" | "),
    ).map((line) => `| ${line} |`),
    "",
    "## Invalid Reasons",
    "",
    ...records
      .filter((record) => record.invalidReasons?.length)
      .map((record) => `- ${record.runId}: ${record.invalidReasons?.join(", ")}`),
    "",
  ].join("\n");

  const jsonRecords = records.map((record) => ({
    ...record,
    outDir: path.relative(root, record.outDir),
    cacheDir: path.relative(root, record.cacheDir),
    stepsPath: record.stepsPath ? path.relative(root, record.stepsPath) : undefined,
    evalResultPath: record.evalResultPath ? path.relative(root, record.evalResultPath) : undefined,
  }));
  await fs.writeFile(path.join(root, "summary.json"), `${JSON.stringify({ records: jsonRecords, rows }, null, 2)}\n`);
  await fs.writeFile(path.join(root, "summary.md"), markdown);
}

function buildRunRecord(options: CliOptions, model: string, runIndex: number): RunRecord {
  const runId = `${model.replace(/[^A-Za-z0-9_.-]/g, "_")}-run-${String(runIndex).padStart(2, "0")}`;
  return {
    model,
    runIndex,
    runId,
    outDir: path.join(options.root, runId, "output"),
    cacheDir: path.join(options.root, runId, "cache"),
    status: "failed",
  };
}

async function completeRecordFromExistingArtifacts(options: CliOptions, record: RunRecord): Promise<void> {
  const runDir = path.join(options.root, record.runId);
  record.stepsPath = await findStepsFile(record.outDir, false);
  const stepStats = await readStepStats(record.stepsPath, options.fallbackThreshold);
  record.stepCount = stepStats.stepCount;
  record.needsReviewCount = stepStats.needsReviewCount;
  record.fallbackSuspected = stepStats.fallbackSuspected;

  record.evalResultPath = path.join(runDir, "eval-result.json");
  await fs.access(record.evalResultPath);
  record.metrics = await readMetrics(record.evalResultPath, options.caseId);

  const pipelineSignals = await readLogSignals(path.join(runDir, "logs", "pipeline.log"));
  const evalSignals = await readLogSignals(path.join(runDir, "logs", "eval.log"));
  record.invalidReasons = detectInvalidReasons(record, [...pipelineSignals, ...evalSignals]);
  record.status = record.invalidReasons.length > 0 ? "invalid" : "passed";
}

async function regenerateSummary(options: CliOptions): Promise<void> {
  const records: RunRecord[] = [];
  for (const model of options.models) {
    for (let i = 1; i <= options.runs; i++) {
      const record = buildRunRecord(options, model, i);
      records.push(record);
      try {
        await completeRecordFromExistingArtifacts(options, record);
      } catch (error) {
        record.status = "failed";
        record.error = error instanceof Error ? error.message : String(error);
        if (!options.continueOnFailure) throw error;
      }
    }
  }
  await writeSummary(options.root, records);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await fs.mkdir(options.root, { recursive: true });

  if (options.dryRun && options.regenerateSummary) {
    throw new Error("--dry-run cannot be combined with --regenerate-summary because regeneration writes summary files");
  }

  if (options.regenerateSummary) {
    await regenerateSummary(options);
    console.log(`Summary regenerated: ${path.relative(repoRoot, path.join(options.root, "summary.md"))}`);
    return;
  }

  const videoPath = path.join(repoRoot, "eval", "dataset", options.caseId, "video.mp4");
  await fs.access(videoPath);

  const records: RunRecord[] = [];
  for (const model of options.models) {
    for (let i = 1; i <= options.runs; i++) {
      const record = buildRunRecord(options, model, i);
      const { runId, outDir, cacheDir } = record;
      const logDir = path.join(options.root, runId, "logs");
      records.push(record);

      if (options.dryRun) {
        console.log(JSON.stringify({
          runId,
          model,
          caseId: options.caseId,
          videoPath,
          outDir,
          cacheDir,
        }));
        continue;
      }

      try {
        await fs.mkdir(outDir, { recursive: true });
        await fs.mkdir(cacheDir, { recursive: true });
        const env = {
          ...process.env,
          LLM_PROVIDER: "openai",
          LLM_MODEL: model,
          PIPELINE_CACHE_DIR: cacheDir,
        };

        const pipelineArgs = [
          "pipeline:generate",
          "--video",
          videoPath,
          "--outdir",
          outDir,
          "--use-audio",
          options.useAudio,
          "--asr-provider",
          options.asrProvider,
          "--ocr-provider",
          options.ocrProvider,
        ];
        if (options.threshold) pipelineArgs.push("--threshold", options.threshold);
        if (options.minInterval) pipelineArgs.push("--min-interval", options.minInterval);
        if (options.maxFrames) pipelineArgs.push("--max-frames", options.maxFrames);

        console.log(`\n=== ${runId}: generate ===`);
        const pipelineLogPath = path.join(logDir, "pipeline.log");
        await runCommand("pnpm", pipelineArgs, {
          cwd: repoRoot,
          env,
          logPath: pipelineLogPath,
        });

        record.stepsPath = await findStepsFile(outDir);
        const stepStats = await readStepStats(record.stepsPath, options.fallbackThreshold);
        record.stepCount = stepStats.stepCount;
        record.needsReviewCount = stepStats.needsReviewCount;
        record.fallbackSuspected = stepStats.fallbackSuspected;

        const beforeEval = await latestJsonFile(path.join(repoRoot, "eval", "results"));
        console.log(`\n=== ${runId}: eval ===`);
        const evalLogPath = path.join(logDir, "eval.log");
        await runCommand("pnpm", ["eval", "--", "--case", options.caseId, "--steps", record.stepsPath], {
          cwd: repoRoot,
          env,
          logPath: evalLogPath,
        });
        const afterEval = await latestJsonFile(path.join(repoRoot, "eval", "results"));
        if (!afterEval || afterEval === beforeEval) {
          throw new Error("Could not identify newly written eval result");
        }
        const evalCopyPath = path.join(options.root, runId, "eval-result.json");
        await fs.copyFile(afterEval, evalCopyPath);
        record.evalResultPath = evalCopyPath;
        record.metrics = await readMetrics(evalCopyPath, options.caseId);
        const pipelineSignals = await readLogSignals(pipelineLogPath);
        const evalSignals = await readLogSignals(evalLogPath);
        record.invalidReasons = detectInvalidReasons(record, [...pipelineSignals, ...evalSignals]);
        record.status = record.invalidReasons.length > 0 ? "invalid" : "passed";
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error);
        console.error(`\n${runId} failed: ${record.error}`);
        if (!options.continueOnFailure) {
          await writeSummary(options.root, records);
          throw error;
        }
      } finally {
        await writeSummary(options.root, records);
      }
    }
  }

  if (options.dryRun) {
    console.log(`\nDry run complete. Planned runs: ${records.length}`);
  } else {
    console.log(`\nSummary: ${path.relative(repoRoot, path.join(options.root, "summary.md"))}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
