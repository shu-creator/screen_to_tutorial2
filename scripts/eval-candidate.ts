#!/usr/bin/env tsx
import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import {
  computeG1,
  computeG2,
  computeG3,
  extractQuotedLabels,
  normalizeLabel,
  type GeneratedStepLike,
  type GroundTruthStep,
} from "../server/eval/metrics";

const repoRoot = path.resolve(import.meta.dirname, "..");
const datasetDir = path.join(repoRoot, "eval", "dataset");
const generatedDir = path.join(repoRoot, "eval", "results", "generated");
const baselinePath = path.join(repoRoot, "eval", "baseline.json");

type StepsArtifact = {
  config?: {
    prompt_version?: unknown;
  };
  steps?: Array<Record<string, unknown>>;
};

type BaselineEntry = {
  caseId: string;
  g2?: { accuracy: number };
  g3?: { rate: number };
};

type BaselineFile = {
  results?: BaselineEntry[];
};

type GroundTruthFile = {
  steps: GroundTruthStep[];
};

export type CandidateEvalOptions = {
  maxG2Regression: number;
  maxG3Regression: number;
  requireG2Improvement: boolean;
  postV1PromotionGate?: boolean;
  includeG2Details?: boolean;
  maxCurrentG2Regression?: number;
  maxCurrentG3Regression?: number;
  maxCurrentNoCitationRegression?: number;
  requireCurrentG2Improvement?: boolean;
  requireCurrentG3Improvement?: boolean;
};

type G2LabelSource = "title" | "operation" | "instruction" | "cited_ui_labels";

type G2LabelDetail = {
  stepNumber: number;
  source: G2LabelSource;
  label: string;
  normalized: string;
  matched: boolean;
};

type G2Details = {
  allowedLabels: string[];
  allowedNormalizedLabels: string[];
  labels: G2LabelDetail[];
  unmatchedLabels: G2LabelDetail[];
  noCitationStepNumbers: number[];
};

export type CandidateEvalResult = {
  pass: boolean;
  caseId: string;
  stepCount: number;
  promptVersion?: string;
  currentPromptVersion?: string;
  g1F1: number;
  g2Accuracy: number;
  baselineG2Accuracy?: number;
  g2Delta?: number;
  currentG2Accuracy?: number;
  currentG2Delta?: number;
  g2NoCitationRate: number;
  currentG2NoCitationRate?: number;
  currentNoCitationDelta?: number;
  g2Details?: G2Details;
  g3Rate: number;
  baselineG3Rate?: number;
  g3Delta?: number;
  currentG3Rate?: number;
  currentG3Delta?: number;
  fallbackReasonCount: number;
  fallbackStepCount: number;
  invalidReasons: string[];
  notes: string[];
};

type CliOptions = CandidateEvalOptions & {
  caseId?: string;
  stepsPath?: string;
  currentStepsPath?: string;
  currentGenerated: boolean;
  json: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    maxG2Regression: 0,
    maxG3Regression: 0,
    requireG2Improvement: false,
    currentGenerated: false,
    json: false,
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
      case "--steps":
        options.stepsPath = requireNext(arg, next);
        i += 1;
        break;
      case "--current-steps":
        options.currentStepsPath = requireNext(arg, next);
        i += 1;
        break;
      case "--current-generated":
        options.currentGenerated = true;
        break;
      case "--max-g2-regression":
        options.maxG2Regression = parseNumber(arg, requireNext(arg, next));
        i += 1;
        break;
      case "--max-g3-regression":
        options.maxG3Regression = parseNumber(arg, requireNext(arg, next));
        i += 1;
        break;
      case "--max-current-g2-regression":
        options.maxCurrentG2Regression = parseNumber(arg, requireNext(arg, next));
        i += 1;
        break;
      case "--max-current-g3-regression":
        options.maxCurrentG3Regression = parseNumber(arg, requireNext(arg, next));
        i += 1;
        break;
      case "--max-current-no-citation-regression":
        options.maxCurrentNoCitationRegression = parseNumber(arg, requireNext(arg, next));
        i += 1;
        break;
      case "--require-g2-improvement":
        options.requireG2Improvement = true;
        break;
      case "--require-current-g2-improvement":
        options.requireCurrentG2Improvement = true;
        break;
      case "--require-current-g3-improvement":
        options.requireCurrentG3Improvement = true;
        break;
      case "--post-v1-promotion-gate":
        options.postV1PromotionGate = true;
        break;
      case "--details":
        options.includeG2Details = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
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

function parseNumber(arg: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${arg} must be a non-negative number`);
  }
  return parsed;
}

export function validateCaseId(caseId: string): void {
  if (!caseId.trim()) {
    throw new Error("--case must not be empty");
  }
  if (caseId === "." || caseId === "..") {
    throw new Error(`--case must not be a directory reference: ${caseId}`);
  }
  if (/[/\\]/.test(caseId)) {
    throw new Error(`--case must not contain path separators: ${caseId}`);
  }
}

export function currentGeneratedStepsPath(caseId: string): string {
  validateCaseId(caseId);
  return path.join(generatedDir, caseId, "steps.json");
}

function printHelp(): void {
  console.log(`Usage:
  pnpm eval:candidate -- --case <case-id> --steps <path/to/steps.json> [options]

Options:
  --require-g2-improvement      Fail unless candidate G2 is above baseline G2.
  --max-g2-regression N         Allowed G2 regression as a ratio. Default: 0.
  --max-g3-regression N         Allowed G3 regression as a ratio. Default: 0.
  --current-steps PATH          Compare against a current tracked/generated steps artifact.
  --current-generated           Compare against eval/results/generated/<case-id>/steps.json.
  --require-current-g2-improvement
                                Fail unless candidate G2 is above current G2.
  --require-current-g3-improvement
                                Fail unless candidate G3 is below current G3.
  --max-current-g2-regression N Allowed G2 regression versus current artifact.
  --max-current-g3-regression N Allowed G3 regression versus current artifact.
  --max-current-no-citation-regression N
                                Allowed no-citation-rate increase versus current artifact.
  --post-v1-promotion-gate      Strict post-v1 candidate gate: compare against the current
                                generated artifact, require fixed-baseline G2 improvement,
                                allow no current G2/no-citation regression, and require
                                current G3 improvement. Current G2 and no-citation
                                tolerances are fixed at 0 while this flag is active.
  --details                     Print G2 cited-label diagnostics for the candidate.
  --json                        Print JSON.

This command reads a candidate steps.json and compares it with eval/baseline.json.
When --current-steps or --current-generated is supplied, it also reports deltas versus that artifact.
It does not write eval results or update the baseline.
`);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
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

function detectFallbackStats(artifact: StepsArtifact): {
  fallbackReasonCount: number;
  fallbackStepCount: number;
} {
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

function artifactPromptVersion(artifact: StepsArtifact | undefined): string | undefined {
  const value = artifact?.config?.prompt_version;
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

function labelEntriesForStep(
  step: GeneratedStepLike,
): Array<{ source: G2LabelSource; label: string }> {
  return [
    ...extractQuotedLabels(step.title).map((label) => ({ source: "title" as const, label })),
    ...extractQuotedLabels(step.operation ?? "").map((label) => ({
      source: "operation" as const,
      label,
    })),
    ...extractQuotedLabels(step.instruction ?? "").map((label) => ({
      source: "instruction" as const,
      label,
    })),
    ...(step.cited_ui_labels ?? []).map((label) => ({
      source: "cited_ui_labels" as const,
      label,
    })),
  ];
}

function buildG2Details(
  generated: GeneratedStepLike[],
  allowedLabels: string[],
): G2Details {
  const allowedNormalizedLabels = Array.from(
    new Set(
      allowedLabels.map(normalizeLabel).filter((label) => label.length > 0),
    ),
  ).sort();
  const allowedSet = new Set(allowedNormalizedLabels);
  const labels: G2LabelDetail[] = [];
  const noCitationStepNumbers: number[] = [];

  generated.forEach((step, index) => {
    const stepLabels = labelEntriesForStep(step);
    let validLabelCount = 0;
    for (const entry of stepLabels) {
      const normalized = normalizeLabel(entry.label);
      if (!normalized) continue;
      validLabelCount += 1;
      labels.push({
        stepNumber: index + 1,
        source: entry.source,
        label: entry.label,
        normalized,
        matched: allowedSet.has(normalized),
      });
    }
    if (validLabelCount === 0) {
      noCitationStepNumbers.push(index + 1);
    }
  });

  return {
    allowedLabels,
    allowedNormalizedLabels,
    labels,
    unmatchedLabels: labels.filter((label) => !label.matched),
    noCitationStepNumbers,
  };
}

export function evaluateCandidate(
  input: {
    caseId: string;
    groundTruth: GroundTruthStep[];
    artifact: StepsArtifact;
    baseline?: BaselineEntry;
    currentArtifact?: StepsArtifact;
  },
  options: CandidateEvalOptions,
): CandidateEvalResult {
  const generated = extractSteps(input.artifact);
  const allowedLabels = input.groundTruth.flatMap((step) => step.ui_labels ?? []);
  const g1 = computeG1(generated, input.groundTruth);
  const g2 = computeG2(generated, allowedLabels);
  const g2Details = options.includeG2Details
    ? buildG2Details(generated, allowedLabels)
    : undefined;
  const g3 = computeG3(generated, input.groundTruth);
  const fallback = detectFallbackStats(input.artifact);
  const baselineG2 = input.baseline?.g2?.accuracy;
  const baselineG3 = input.baseline?.g3?.rate;
  const g2Delta = baselineG2 === undefined ? undefined : g2.accuracy - baselineG2;
  const g3Delta = baselineG3 === undefined ? undefined : g3.rate - baselineG3;
  const requireG2Improvement = options.requireG2Improvement || Boolean(options.postV1PromotionGate);
  const requireCurrentG3Improvement = options.requireCurrentG3Improvement || Boolean(options.postV1PromotionGate);
  const maxCurrentG2Regression = options.postV1PromotionGate
    ? 0
    : options.maxCurrentG2Regression;
  const maxCurrentNoCitationRegression = options.postV1PromotionGate
    ? 0
    : options.maxCurrentNoCitationRegression;
  const needsCurrentComparison = Boolean(
    input.currentArtifact ||
      options.postV1PromotionGate ||
      options.requireCurrentG2Improvement ||
      requireCurrentG3Improvement ||
      maxCurrentG2Regression !== undefined ||
      options.maxCurrentG3Regression !== undefined ||
      maxCurrentNoCitationRegression !== undefined,
  );
  const currentGenerated = input.currentArtifact === undefined
    ? undefined
    : extractSteps(input.currentArtifact);
  const currentG2 = currentGenerated === undefined
    ? undefined
    : computeG2(currentGenerated, allowedLabels);
  const currentG3 = currentGenerated === undefined
    ? undefined
    : computeG3(currentGenerated, input.groundTruth);
  const currentG2Delta = currentG2 === undefined
    ? undefined
    : g2.accuracy - currentG2.accuracy;
  const currentG3Delta = currentG3 === undefined
    ? undefined
    : g3.rate - currentG3.rate;
  const currentNoCitationDelta = currentG2 === undefined
    ? undefined
    : g2.noCitationRate - currentG2.noCitationRate;
  const invalidReasons: string[] = [];
  const notes: string[] = [];

  if (!input.baseline) {
    invalidReasons.push("missing_baseline");
  }
  if (needsCurrentComparison && !input.currentArtifact) {
    invalidReasons.push("missing_current_artifact");
  }
  if (fallback.fallbackReasonCount > 0) {
    invalidReasons.push("fallback_reasons_present");
  }
  if (g2Delta !== undefined && g2Delta < -options.maxG2Regression) {
    invalidReasons.push("g2_regression");
  }
  if (g3Delta !== undefined && g3Delta > options.maxG3Regression) {
    invalidReasons.push("g3_regression");
  }
  if (requireG2Improvement && (g2Delta === undefined || g2Delta <= 0)) {
    invalidReasons.push("g2_not_improved");
  }
  if (
    currentG2Delta !== undefined &&
    maxCurrentG2Regression !== undefined &&
    currentG2Delta < -maxCurrentG2Regression
  ) {
    invalidReasons.push("current_g2_regression");
  }
  if (
    currentG3Delta !== undefined &&
    options.maxCurrentG3Regression !== undefined &&
    currentG3Delta > options.maxCurrentG3Regression
  ) {
    invalidReasons.push("current_g3_regression");
  }
  if (
    currentNoCitationDelta !== undefined &&
    maxCurrentNoCitationRegression !== undefined &&
    currentNoCitationDelta > maxCurrentNoCitationRegression
  ) {
    invalidReasons.push("current_no_citation_regression");
  }
  if (
    options.requireCurrentG2Improvement &&
    (currentG2Delta === undefined || currentG2Delta <= 0)
  ) {
    invalidReasons.push("current_g2_not_improved");
  }
  if (
    requireCurrentG3Improvement &&
    (currentG3Delta === undefined || currentG3Delta >= 0)
  ) {
    invalidReasons.push("current_g3_not_improved");
  }
  if (generated.length === 0) {
    invalidReasons.push("empty_steps");
  }
  if (g2.totalLabels === 0) {
    notes.push("candidate has no cited UI labels");
  }

  return {
    pass: invalidReasons.length === 0,
    caseId: input.caseId,
    stepCount: generated.length,
    promptVersion: artifactPromptVersion(input.artifact),
    currentPromptVersion: artifactPromptVersion(input.currentArtifact),
    g1F1: g1.f1,
    g2Accuracy: g2.accuracy,
    baselineG2Accuracy: baselineG2,
    g2Delta,
    currentG2Accuracy: currentG2?.accuracy,
    currentG2Delta,
    g2NoCitationRate: g2.noCitationRate,
    currentG2NoCitationRate: currentG2?.noCitationRate,
    currentNoCitationDelta,
    g2Details,
    g3Rate: g3.rate,
    baselineG3Rate: baselineG3,
    g3Delta,
    currentG3Rate: currentG3?.rate,
    currentG3Delta,
    fallbackReasonCount: fallback.fallbackReasonCount,
    fallbackStepCount: fallback.fallbackStepCount,
    invalidReasons,
    notes,
  };
}

function pct(value: number | undefined): string {
  return value === undefined ? "-" : `${(value * 100).toFixed(1)}%`;
}

function signedPct(value: number | undefined): string {
  if (value === undefined) return "-";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

function printResult(result: CandidateEvalResult): void {
  console.log(`Candidate eval: ${result.pass ? "PASS" : "FAIL"}`);
  console.log(`case: ${result.caseId}`);
  console.log(`steps: ${result.stepCount}`);
  console.log(`prompt version: ${result.promptVersion ?? "-"}`);
  if (result.currentPromptVersion !== undefined) {
    console.log(`current artifact prompt version: ${result.currentPromptVersion}`);
  }
  console.log(`G1-F1: ${pct(result.g1F1)}`);
  console.log(`G2: ${pct(result.g2Accuracy)} (baseline ${pct(result.baselineG2Accuracy)}, delta ${signedPct(result.g2Delta)})`);
  if (result.currentG2Accuracy !== undefined) {
    console.log(
      `G2 vs current: ${pct(result.g2Accuracy)} (current ${pct(result.currentG2Accuracy)}, delta ${signedPct(result.currentG2Delta)})`,
    );
  }
  console.log(`G2 no-citation: ${pct(result.g2NoCitationRate)}`);
  if (result.currentG2NoCitationRate !== undefined) {
    console.log(
      `G2 no-citation vs current: ${pct(result.g2NoCitationRate)} (current ${pct(result.currentG2NoCitationRate)}, delta ${signedPct(result.currentNoCitationDelta)})`,
    );
  }
  if (result.g2Details) {
    printG2Details(result.g2Details);
  }
  console.log(`G3: ${pct(result.g3Rate)} (baseline ${pct(result.baselineG3Rate)}, delta ${signedPct(result.g3Delta)})`);
  if (result.currentG3Rate !== undefined) {
    console.log(
      `G3 vs current: ${pct(result.g3Rate)} (current ${pct(result.currentG3Rate)}, delta ${signedPct(result.currentG3Delta)})`,
    );
  }
  console.log(`fallback reasons: ${result.fallbackReasonCount}`);
  if (result.invalidReasons.length > 0) {
    console.log("Invalid reasons:");
    for (const reason of result.invalidReasons) console.log(`- ${reason}`);
  }
  if (result.notes.length > 0) {
    console.log("Notes:");
    for (const note of result.notes) console.log(`- ${note}`);
  }
}

function printG2Details(details: G2Details): void {
  console.log(`G2 allowed labels: ${details.allowedLabels.length ? details.allowedLabels.join(", ") : "(none)"}`);
  if (details.unmatchedLabels.length > 0) {
    console.log("G2 unmatched labels:");
    for (const detail of details.unmatchedLabels) {
      console.log(
        `- step ${detail.stepNumber} ${detail.source}: ${detail.label} -> ${detail.normalized}`,
      );
    }
  } else {
    console.log("G2 unmatched labels: none");
  }
  if (details.noCitationStepNumbers.length > 0) {
    console.log(`G2 no-citation steps: ${details.noCitationStepNumbers.join(", ")}`);
  } else {
    console.log("G2 no-citation steps: none");
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options.caseId) throw new Error("--case is required");
  if (!options.stepsPath) throw new Error("--steps is required");
  validateCaseId(options.caseId);
  if (options.postV1PromotionGate && !options.currentStepsPath) {
    options.currentGenerated = true;
  }
  const currentComparisonRequested = Boolean(
    options.currentStepsPath ||
      options.currentGenerated ||
      options.postV1PromotionGate ||
      options.requireCurrentG2Improvement ||
      options.requireCurrentG3Improvement ||
      options.maxCurrentG2Regression !== undefined ||
      options.maxCurrentG3Regression !== undefined ||
      options.maxCurrentNoCitationRegression !== undefined,
  );
  if (options.currentStepsPath && options.currentGenerated) {
    throw new Error("--current-steps and --current-generated cannot be used together");
  }
  const currentStepsPath = options.currentGenerated
    ? currentGeneratedStepsPath(options.caseId)
    : options.currentStepsPath;
  if (currentComparisonRequested && !currentStepsPath) {
    throw new Error(
      "--current-steps or --current-generated is required for current-artifact comparison options",
    );
  }

  const groundTruth = await readJson<GroundTruthFile>(
    path.join(datasetDir, options.caseId, "ground_truth.json"),
  );
  const artifact = await readJson<StepsArtifact>(path.resolve(options.stepsPath));
  const currentArtifact = currentStepsPath
    ? await readJson<StepsArtifact>(path.resolve(currentStepsPath))
    : undefined;
  const baselineFile = await readJson<BaselineFile>(baselinePath);
  const baseline = baselineFile.results?.find((entry) => entry.caseId === options.caseId);
  const result = evaluateCandidate(
    {
      caseId: options.caseId,
      groundTruth: groundTruth.steps,
      artifact,
      baseline,
      currentArtifact,
    },
    options,
  );

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
