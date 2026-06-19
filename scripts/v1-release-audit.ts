#!/usr/bin/env tsx
import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import { auditEvalReadiness, readCaseMetas, validateG4Record, type G4Record } from "./eval-audit";

type AuditOptions = {
  json: boolean;
  allowIncomplete: boolean;
  v1SmokeSummary: string;
  freshEnvSummary: string;
};

type CheckStatus = "pass" | "fail" | "incomplete";

type ReleaseCheck = {
  name: string;
  status: CheckStatus;
  detail: string;
};

type V1SmokeSummary = {
  pass?: boolean;
  project_id?: number | null;
  environment?: {
    kind?: string;
    source_commit?: string;
    dependency_install?: {
      command?: string;
      mode?: string;
    };
  };
  options?: {
    ocr_provider?: string;
  };
  artifacts?: {
    steps?: string | null;
    export_summary?: string | null;
    edit_smoke_summary?: string | null;
  };
  metrics?: {
    step_count?: number;
    fallback_reason_count?: number;
  };
  checks?: Array<{ name?: string; pass?: boolean; detail?: string }>;
};

type ExportQaSummary = {
  case_id?: string;
  artifacts?: {
    pptx?: string;
    video?: string;
  };
  qa_checks?: {
    pptx?: {
      cover_slide?: boolean;
      completion_slide?: boolean;
      slide_count?: number;
      expected_slide_count?: number;
    };
    video?: {
      duration_sec?: number;
      audio_stream?: boolean;
      drawtext_unavailable_behavior?: string;
    };
  };
};

const repoRoot = path.resolve(import.meta.dirname, "..");
const requiredExportQaCases = 2;
const requiredHumanG4RealCases = 2;

function parseArgs(argv: string[]): AuditOptions {
  const options: AuditOptions = {
    json: false,
    allowIncomplete: false,
    v1SmokeSummary: "outputs/v1-smoke-default-check/v1_smoke_summary.json",
    freshEnvSummary: "outputs/v1-fresh-env-smoke/v1_smoke_summary.json",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") {
      continue;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--allow-incomplete") {
      options.allowIncomplete = true;
    } else if (arg === "--v1-smoke-summary") {
      if (!next || next.startsWith("--")) throw new Error("--v1-smoke-summary requires a path");
      options.v1SmokeSummary = next;
      i += 1;
    } else if (arg === "--fresh-env-summary") {
      if (!next || next.startsWith("--")) throw new Error("--fresh-env-summary requires a path");
      options.freshEnvSummary = next;
      i += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function safeReadJson<T>(filePath: string): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await readJson<T>(filePath) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function resolveRepoPath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);
}

function rel(filePath: string): string {
  return path.relative(repoRoot, filePath);
}

function pass(name: string, detail: string): ReleaseCheck {
  return { name, status: "pass", detail };
}

function fail(name: string, detail: string): ReleaseCheck {
  return { name, status: "fail", detail };
}

function incomplete(name: string, detail: string): ReleaseCheck {
  return { name, status: "incomplete", detail };
}

async function checkRequiredFiles(): Promise<ReleaseCheck> {
  const files = [
    ".env.example",
    "README.md",
    "docs/setup-local.md",
    "docs/v1-release-checklist.md",
    "docs/roadmap.md",
  ];
  const missing: string[] = [];
  for (const file of files) {
    if (!(await fileExists(path.join(repoRoot, file)))) missing.push(file);
  }
  return missing.length === 0
    ? pass("release.docs", `found ${files.join(", ")}`)
    : fail("release.docs", `missing: ${missing.join(", ")}`);
}

async function checkModelDefault(): Promise<ReleaseCheck> {
  let envExample: string;
  try {
    envExample = await fs.readFile(path.join(repoRoot, ".env.example"), "utf8");
  } catch (error) {
    return fail("model.default", `could not read .env.example: ${error instanceof Error ? error.message : String(error)}`);
  }
  const hasModel = envExample
    .split("\n")
    .map((line) => line.trim().replace(/\s+#.*$/, ""))
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .includes("LLM_MODEL=gpt-5.4");
  return hasModel
    ? pass("model.default", ".env.example keeps LLM_MODEL=gpt-5.4")
    : fail("model.default", ".env.example does not contain LLM_MODEL=gpt-5.4");
}

export async function checkV1Smoke(
  summaryPath: string,
  name: string,
  requireFreshEvidence: boolean,
  missingStatus: Exclude<CheckStatus, "pass"> = "incomplete",
): Promise<ReleaseCheck> {
  const absolutePath = resolveRepoPath(summaryPath);
  if (!(await fileExists(absolutePath))) {
    const detail = `missing summary: ${summaryPath}`;
    return missingStatus === "fail" ? fail(name, detail) : incomplete(name, detail);
  }

  const parsed = await safeReadJson<V1SmokeSummary>(absolutePath);
  if (!parsed.value) {
    return fail(name, `${rel(absolutePath)}: could not parse JSON: ${parsed.error ?? "unknown error"}`);
  }
  const summary = parsed.value;
  const failedChecks = (summary.checks ?? []).filter((check) => check.pass !== true);
  const requiredArtifacts = {
    steps: summary.artifacts?.steps,
    export_summary: summary.artifacts?.export_summary,
    edit_smoke_summary: summary.artifacts?.edit_smoke_summary,
  };
  const missingArtifactFields = Object.entries(requiredArtifacts)
    .filter(([, artifactPath]) => !artifactPath)
    .map(([field]) => field);
  const artifactPaths = Object.values(requiredArtifacts).filter((artifactPath): artifactPath is string => Boolean(artifactPath));
  const missingArtifacts: string[] = [];
  for (const artifactPath of artifactPaths) {
    if (!(await fileExists(resolveRepoPath(artifactPath)))) missingArtifacts.push(artifactPath);
  }
  const reasons: string[] = [];
  if (summary.pass !== true) reasons.push("summary pass is not true");
  if (failedChecks.length > 0) reasons.push(`failed checks: ${failedChecks.map((check) => check.name ?? "unnamed").join(", ")}`);
  if ((summary.metrics?.step_count ?? 0) <= 0) reasons.push("step_count is not positive");
  if (summary.metrics?.fallback_reason_count !== 0) reasons.push(`fallback_reason_count=${summary.metrics?.fallback_reason_count ?? "missing"}; expected 0`);
  if (missingArtifactFields.length > 0) reasons.push(`missing artifact fields: ${missingArtifactFields.join(", ")}`);
  if (missingArtifacts.length > 0) reasons.push(`missing artifacts: ${missingArtifacts.join(", ")}`);
  if (requireFreshEvidence && summary.options?.ocr_provider !== "none") {
    reasons.push(`expected fresh smoke to use deterministic ocr_provider=none, got ${summary.options?.ocr_provider ?? "missing"}`);
  }
  if (requireFreshEvidence) {
    if (summary.environment?.kind !== "fresh_checkout") {
      reasons.push(`expected environment.kind=fresh_checkout, got ${summary.environment?.kind ?? "missing"}`);
    }
    if (!summary.environment?.source_commit) {
      reasons.push("missing environment.source_commit");
    }
    if (!summary.environment?.dependency_install?.command) {
      reasons.push("missing environment.dependency_install.command");
    }
  }

  if (reasons.length > 0) {
    return fail(name, `${rel(absolutePath)}: ${reasons.join("; ")}`);
  }
  return pass(
    name,
    `${rel(absolutePath)} project=${summary.project_id ?? "unknown"} steps=${summary.metrics?.step_count ?? "unknown"} fallback_reasons=0`,
  );
}

async function checkEvalReadiness(): Promise<ReleaseCheck> {
  let result: Awaited<ReturnType<typeof auditEvalReadiness>>;
  try {
    result = await auditEvalReadiness();
  } catch (error) {
    return fail("eval.readiness", `auditEvalReadiness threw: ${error instanceof Error ? error.message : String(error)}`);
  }
  const warningSummary = result.warnings.length > 0 ? `; warnings=${result.warnings.length}` : "";
  return result.pass
    ? pass("eval.readiness", `real_cases=${result.realCaseCount}/${result.requiredRealCaseCount}${warningSummary}`)
    : fail("eval.readiness", result.notes.join("; ") || "eval readiness failed");
}

async function checkHumanG4(): Promise<ReleaseCheck> {
  const recordsDir = path.join(repoRoot, "eval", "g4", "records");
  const entries = await fs.readdir(recordsDir, { withFileTypes: true }).catch(() => []);
  let caseMetas: Awaited<ReturnType<typeof readCaseMetas>>;
  try {
    caseMetas = await readCaseMetas();
  } catch (error) {
    return fail("g4.human_review", `readCaseMetas threw: ${error instanceof Error ? error.message : String(error)}`);
  }
  const requiredRealCaseIds = caseMetas
    .filter((meta) => meta.synthetic === false)
    .map((meta) => meta.case_id)
    .sort();
  const records: G4Record[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(recordsDir, entry.name);
    const parsed = await safeReadJson<G4Record>(filePath);
    if (!parsed.value) {
      return fail("g4.human_review", `could not read ${rel(filePath)}: ${parsed.error ?? "invalid JSON"}`);
    }
    records.push(parsed.value);
  }
  const humanCaseIds = new Set<string>();
  for (const record of records) {
    if (record.review_type !== "human_review" || !requiredRealCaseIds.includes(record.case_id)) continue;
    const invalidReason = await validateG4Record(record);
    if (!invalidReason) humanCaseIds.add(record.case_id);
  }
  if (humanCaseIds.size < requiredHumanG4RealCases) {
    return incomplete(
      "g4.human_review",
      `required real-case human_review G4 records ${humanCaseIds.size}/${requiredHumanG4RealCases}; current records are not release G4 evidence`,
    );
  }
  return pass("g4.human_review", `required real-case human_review records: ${Array.from(humanCaseIds).sort().join(", ")}`);
}

async function checkExportQa(): Promise<ReleaseCheck> {
  const exportRoot = path.join(repoRoot, "eval", "results", "export-qa");
  const entries = await fs.readdir(exportRoot, { withFileTypes: true }).catch(() => []);
  const summaries: ExportQaSummary[] = [];
  const unreadable: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const summaryPath = path.join(exportRoot, entry.name, "qa-summary.json");
    if (await fileExists(summaryPath)) {
      const parsed = await safeReadJson<ExportQaSummary>(summaryPath);
      if (parsed.value) summaries.push(parsed.value);
      else unreadable.push(`${rel(summaryPath)}: ${parsed.error ?? "invalid JSON"}`);
    }
  }

  const validCases: string[] = [];
  const invalid: string[] = [];
  for (const summary of summaries) {
    const caseId = summary.case_id ?? "unknown";
    const pptx = summary.qa_checks?.pptx;
    const video = summary.qa_checks?.video;
    const artifactPaths = [summary.artifacts?.pptx, summary.artifacts?.video].filter(
      (artifactPath): artifactPath is string => Boolean(artifactPath),
    );
    const artifactsExist = await Promise.all(artifactPaths.map(async (artifactPath) => fileExists(resolveRepoPath(artifactPath))));
    const ok = pptx?.cover_slide === true
      && pptx.completion_slide === true
      && pptx.slide_count === pptx.expected_slide_count
      && (video?.duration_sec ?? 0) > 0
      && video?.audio_stream === true
      && artifactPaths.length === 2
      && artifactsExist.every(Boolean);
    if (ok) validCases.push(caseId);
    else invalid.push(caseId);
  }

  if (unreadable.length > 0 || invalid.length > 0) {
    return fail("export.qa", `invalid=${invalid.join(", ") || "-"}; unreadable=${unreadable.join("; ") || "-"}`);
  }
  if (validCases.length < requiredExportQaCases) {
    return incomplete("export.qa", `valid export QA cases ${validCases.length}/${requiredExportQaCases}`);
  }
  return pass("export.qa", `valid export QA cases: ${validCases.sort().join(", ")}`);
}

async function runAudit(options: AuditOptions): Promise<{ pass: boolean; status: CheckStatus; checks: ReleaseCheck[] }> {
  const checks = [
    await checkRequiredFiles(),
    await checkModelDefault(),
    await checkEvalReadiness(),
    await checkV1Smoke(options.v1SmokeSummary, "smoke.current_environment", false, "fail"),
    await checkExportQa(),
    await checkHumanG4(),
    await checkV1Smoke(options.freshEnvSummary, "smoke.fresh_environment", true),
  ];
  const status = topLevelStatus(checks);
  return {
    pass: status === "pass",
    status,
    checks,
  };
}

export function topLevelStatus(checks: ReleaseCheck[]): CheckStatus {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "incomplete")) return "incomplete";
  return "pass";
}

export function shouldExitWithFailure(result: { pass: boolean; checks: ReleaseCheck[] }, allowIncomplete: boolean): boolean {
  if (result.pass) return false;
  const hasFailures = result.checks.some((check) => check.status === "fail");
  return hasFailures || !allowIncomplete;
}

function printAudit(result: { pass: boolean; status: CheckStatus; checks: ReleaseCheck[] }): void {
  const status = result.status;
  console.log(`v1 release audit: ${status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "INCOMPLETE"}`);
  for (const check of result.checks) {
    const prefix = check.status === "pass" ? "PASS" : check.status === "fail" ? "FAIL" : "INCOMPLETE";
    console.log(`${prefix} ${check.name}: ${check.detail}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await runAudit(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printAudit(result);
  }
  if (shouldExitWithFailure(result, options.allowIncomplete)) {
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
