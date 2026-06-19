#!/usr/bin/env tsx
import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import {
  computeG1,
  computeG2,
  computeG3,
  type GeneratedStepLike,
  type GroundTruthStep,
} from "../server/eval/metrics";

type CaseMeta = {
  case_id: string;
  synthetic?: boolean;
};

type GroundTruthFile = {
  steps: GroundTruthStep[];
};

type StepsArtifact = {
  steps?: Array<Record<string, unknown>>;
};

type BaselineFile = {
  results?: Array<{
    caseId: string;
    g2?: { accuracy: number };
    g3?: { rate: number };
  }>;
};

type GateOptions = {
  maxG3Average: number;
  maxG3AverageRegression: number;
  maxG2Regression: number;
  json: boolean;
};

type CaseGateResult = {
  caseId: string;
  g1F1?: number;
  g2Accuracy?: number;
  baselineG2Accuracy?: number;
  g2Delta?: number;
  g3Rate?: number;
  baselineG3Rate?: number;
  fallbackReasonCount: number;
  fallbackStepCount: number;
  invalidReasons: string[];
};

const repoRoot = path.resolve(import.meta.dirname, "..");
const datasetDir = path.join(repoRoot, "eval", "dataset");
const generatedDir = path.join(repoRoot, "eval", "results", "generated");
const baselinePath = path.join(repoRoot, "eval", "baseline.json");

function parseArgs(argv: string[]): GateOptions {
  const options: GateOptions = {
    maxG3Average: 0.1,
    maxG3AverageRegression: 0,
    maxG2Regression: 0,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--max-g3-average":
        options.maxG3Average = Number(requireNext(arg, next));
        i++;
        break;
      case "--max-g3-average-regression":
        options.maxG3AverageRegression = Number(requireNext(arg, next));
        i++;
        break;
      case "--max-g2-regression":
        options.maxG2Regression = Number(requireNext(arg, next));
        i++;
        break;
      case "--json":
        options.json = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function requireNext(arg: string, next: string | undefined): string {
  if (!next || next.startsWith("--")) {
    throw new Error(`${arg} requires a value`);
  }
  return next;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}

async function readRealCases(): Promise<CaseMeta[]> {
  const entries = await fs.readdir(datasetDir, { withFileTypes: true });
  const cases: CaseMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(datasetDir, entry.name, "meta.json");
    if (!(await fileExists(metaPath))) continue;
    const meta = await readJson<CaseMeta>(metaPath);
    if (meta.synthetic === false) cases.push(meta);
  }
  return cases.sort((a, b) => a.case_id.localeCompare(b.case_id));
}

function extractSteps(artifact: StepsArtifact): GeneratedStepLike[] {
  if (!Array.isArray(artifact.steps)) {
    throw new Error("steps.json に steps 配列がありません");
  }
  return artifact.steps.map((step) => ({
    t_start: Number(step.t_start ?? 0),
    t_end: Number(step.t_end ?? 0),
    title: String(step.title ?? ""),
    operation: typeof step.operation === "string" ? step.operation : undefined,
    instruction: typeof step.instruction === "string" ? step.instruction : undefined,
    cited_ui_labels: Array.isArray(step.cited_ui_labels)
      ? step.cited_ui_labels.filter((label): label is string => typeof label === "string")
      : undefined,
  }));
}

function detectFallbackStats(artifact: StepsArtifact): { fallbackReasonCount: number; fallbackStepCount: number } {
  let fallbackReasonCount = 0;
  let fallbackStepCount = 0;
  for (const step of artifact.steps ?? []) {
    const reasons = Array.isArray(step.review_reasons)
      ? step.review_reasons.filter((reason): reason is string => typeof reason === "string")
      : [];
    const fallbackReasons = reasons.filter((reason) => reason.startsWith("fallback:"));
    fallbackReasonCount += fallbackReasons.length;
    if (fallbackReasons.length > 0) fallbackStepCount += 1;
  }
  return { fallbackReasonCount, fallbackStepCount };
}

function average(values: Array<number | undefined>): number | undefined {
  const finite = values.filter((value): value is number => Number.isFinite(value));
  if (finite.length === 0) return undefined;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function pct(value: number | undefined): string {
  return value === undefined ? "-" : `${(value * 100).toFixed(1)}%`;
}

async function runGate(options: GateOptions): Promise<{
  pass: boolean;
  realCaseCount: number;
  g2Average?: number;
  baselineG2Average?: number;
  g3Average?: number;
  baselineG3Average?: number;
  results: CaseGateResult[];
  notes: string[];
}> {
  const realCases = await readRealCases();
  const baseline = await readJson<BaselineFile>(baselinePath);
  const baselineByCase = new Map((baseline.results ?? []).map((entry) => [entry.caseId, entry]));
  const results: CaseGateResult[] = [];
  const notes: string[] = [];
  if (realCases.length < 5) {
    notes.push(`real_case_count ${realCases.length}/5`);
  }

  for (const meta of realCases) {
    const caseId = meta.case_id;
    const gt = await readJson<GroundTruthFile>(path.join(datasetDir, caseId, "ground_truth.json"));
    const stepsPath = path.join(generatedDir, caseId, "steps.json");
    if (!(await fileExists(stepsPath))) {
      results.push({
        caseId,
        fallbackReasonCount: 0,
        fallbackStepCount: 0,
        invalidReasons: ["missing_steps"],
      });
      notes.push(`${caseId}: missing generated steps`);
      continue;
    }

    const artifact = await readJson<StepsArtifact>(stepsPath);
    const generated = extractSteps(artifact);
    const allowedLabels = gt.steps.flatMap((step) => step.ui_labels ?? []);
    const g1 = computeG1(generated, gt.steps);
    const g2 = computeG2(generated, allowedLabels);
    const g3 = computeG3(generated, gt.steps);
    const fallback = detectFallbackStats(artifact);
    const baselineEntry = baselineByCase.get(caseId);
    if (!baselineEntry) {
      notes.push(`${caseId}: missing_from_baseline`);
    }
    const g2Delta = baselineEntry?.g2?.accuracy === undefined
      ? undefined
      : g2.accuracy - baselineEntry.g2.accuracy;
    const invalidReasons: string[] = [];

    if (fallback.fallbackReasonCount > 0) invalidReasons.push("fallback_reasons_present");
    if (g2Delta !== undefined && g2Delta < -options.maxG2Regression) invalidReasons.push("g2_regression");

    const result: CaseGateResult = {
      caseId,
      g1F1: g1.f1,
      g2Accuracy: g2.accuracy,
      baselineG2Accuracy: baselineEntry?.g2?.accuracy,
      g2Delta,
      g3Rate: g3.rate,
      baselineG3Rate: baselineEntry?.g3?.rate,
      fallbackReasonCount: fallback.fallbackReasonCount,
      fallbackStepCount: fallback.fallbackStepCount,
      invalidReasons,
    };
    results.push(result);
    for (const reason of invalidReasons) {
      notes.push(`${caseId}: ${reason}`);
    }
  }

  const g2Average = average(results.map((result) => result.g2Accuracy));
  const baselineG2Average = average(results.map((result) => result.baselineG2Accuracy));
  const g3Average = average(results.map((result) => result.g3Rate));
  const baselineG3Average = average(results.map((result) => result.baselineG3Rate));
  if (g3Average === undefined) {
    notes.push("missing current G3 average");
  } else {
    if (g3Average > options.maxG3Average) {
      notes.push(`G3 average ${pct(g3Average)} exceeds max ${pct(options.maxG3Average)}`);
    }
    if (
      baselineG3Average !== undefined &&
      g3Average - baselineG3Average > options.maxG3AverageRegression
    ) {
      notes.push(`G3 average regression ${pct(g3Average - baselineG3Average)} exceeds max ${pct(options.maxG3AverageRegression)}`);
    }
  }

  return {
    pass: notes.length === 0,
    realCaseCount: realCases.length,
    g2Average,
    baselineG2Average,
    g3Average,
    baselineG3Average,
    results,
    notes,
  };
}

function printResult(result: Awaited<ReturnType<typeof runGate>>): void {
  console.log(`Sprint 2 quality gate: ${result.pass ? "PASS" : "FAIL"}`);
  console.log(`Real cases: ${result.realCaseCount}`);
  console.log(`G2 avg: ${pct(result.g2Average)} (baseline ${pct(result.baselineG2Average)})`);
  console.log(`G3 avg: ${pct(result.g3Average)} (baseline ${pct(result.baselineG3Average)})`);
  console.log("");
  console.log("case".padEnd(42), "G2".padEnd(8), "G2Δ".padEnd(8), "G3".padEnd(8), "fallback", "status");
  console.log("-".repeat(92));
  for (const row of result.results) {
    console.log(
      row.caseId.padEnd(42),
      pct(row.g2Accuracy).padEnd(8),
      pct(row.g2Delta).padEnd(8),
      pct(row.g3Rate).padEnd(8),
      String(row.fallbackReasonCount).padEnd(8),
      row.invalidReasons.length ? row.invalidReasons.join(",") : "ok",
    );
  }
  if (result.notes.length) {
    console.log("");
    console.log("Open items:");
    for (const note of result.notes) console.log(`- ${note}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await runGate(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printResult(result);
  }
  if (!result.pass) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
