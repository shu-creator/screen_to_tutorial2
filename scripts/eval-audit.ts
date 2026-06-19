#!/usr/bin/env tsx
import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";

export type CaseMeta = {
  case_id: string;
  synthetic?: boolean;
  has_narration?: boolean;
  scenario_tags?: string[];
};

export type G4Record = {
  case_id: string;
  review_type?: string;
  reviewer?: string;
  reviewed_at?: string;
  source_artifact?: string;
  exported_artifacts?: string[];
  counts?: Record<string, number>;
  total_manual_edits?: number;
};

export type AuditResult = {
  pass: boolean;
  realCaseCount: number;
  requiredRealCaseCount: number;
  requiredTags: string[];
  coveredTags: string[];
  missingTags: string[];
  casesMissingGeneratedSteps: string[];
  casesMissingG4: string[];
  invalidG4Records: string[];
  warnings: string[];
  notes: string[];
};

const repoRoot = path.resolve(import.meta.dirname, "..");
const datasetDir = path.join(repoRoot, "eval", "dataset");
const generatedDir = path.join(repoRoot, "eval", "results", "generated");
const g4Dir = path.join(repoRoot, "eval", "g4", "records");

const requiredTags = [
  "silent",
  "narrated",
  "form_input",
  "load_wait",
  "modal_or_dropdown",
];

const requiredG4CountKeys = [
  "title_edits",
  "description_edits",
  "narration_edits",
  "timing_edits",
  "citation_edits",
  "step_structure_edits",
  "export_artifact_edits",
  "other_edits",
];

function parseArgs(argv: string[]): Record<string, boolean> {
  return Object.fromEntries(argv.filter((arg) => arg.startsWith("--")).map((arg) => [arg.slice(2), true]));
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}

export async function readCaseMetas(root = datasetDir): Promise<CaseMeta[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const metas: CaseMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(root, entry.name, "meta.json");
    if (await fileExists(metaPath)) {
      metas.push(await readJson<CaseMeta>(metaPath));
    }
  }
  return metas.sort((a, b) => a.case_id.localeCompare(b.case_id));
}

async function readG4Records(root = g4Dir): Promise<G4Record[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const records: G4Record[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      records.push(await readJson<G4Record>(path.join(root, entry.name)));
    }
  }
  return records;
}

export async function auditEvalReadiness(options: {
  caseMetas?: CaseMeta[];
  g4Records?: G4Record[];
  generatedCaseIds?: string[];
  generatedRoot?: string;
  requiredRealCaseCount?: number;
} = {}): Promise<AuditResult> {
  const caseMetas = options.caseMetas ?? await readCaseMetas();
  const g4Records = options.g4Records ?? await readG4Records();
  const generatedRoot = options.generatedRoot ?? generatedDir;
  const requiredRealCaseCount = options.requiredRealCaseCount ?? 5;
  const realCases = caseMetas.filter((meta) => meta.synthetic === false);
  const realCaseIds = new Set(realCases.map((meta) => meta.case_id));
  const coveredTags = Array.from(new Set(realCases.flatMap((meta) => meta.scenario_tags ?? []))).sort();
  const missingTags = requiredTags.filter((tag) => !coveredTags.includes(tag));
  const g4ByCaseId = new Map(g4Records.map((record) => [record.case_id, record]));

  const casesMissingGeneratedSteps: string[] = [];
  const generatedCaseIds = options.generatedCaseIds ? new Set(options.generatedCaseIds) : null;
  for (const caseId of Array.from(realCaseIds)) {
    const hasGeneratedSteps = generatedCaseIds
      ? generatedCaseIds.has(caseId)
      : await fileExists(path.join(generatedRoot, caseId, "steps.json"));
    if (!hasGeneratedSteps) {
      casesMissingGeneratedSteps.push(caseId);
    }
  }
  casesMissingGeneratedSteps.sort();

  const casesMissingG4: string[] = [];
  const invalidG4Records: string[] = [];
  const warnings: string[] = [];
  for (const caseId of Array.from(realCaseIds).sort()) {
    const record = g4ByCaseId.get(caseId);
    if (!record) {
      casesMissingG4.push(caseId);
      continue;
    }
    const invalidReason = validateG4Record(record);
    if (invalidReason) {
      invalidG4Records.push(`${caseId}: ${invalidReason}`);
    }
    if (!record.review_type) {
      warnings.push(`${caseId}: G4 review_type is missing`);
    } else if (record.review_type === "ai_estimate") {
      warnings.push(`${caseId}: G4 is ai_estimate, not human_review`);
    }
  }
  const notes: string[] = [];
  if (realCases.length < requiredRealCaseCount) {
    notes.push(`real recording cases ${realCases.length}/${requiredRealCaseCount}`);
  }
  for (const tag of missingTags) {
    notes.push(`missing required scenario tag: ${tag}`);
  }
  for (const caseId of casesMissingGeneratedSteps) {
    notes.push(`missing generated steps for real case: ${caseId}`);
  }
  for (const caseId of casesMissingG4) {
    notes.push(`missing G4 record for real case: ${caseId}`);
  }
  for (const issue of invalidG4Records) {
    notes.push(`invalid G4 record: ${issue}`);
  }

  return {
    pass: notes.length === 0,
    realCaseCount: realCases.length,
    requiredRealCaseCount,
    requiredTags,
    coveredTags,
    missingTags,
    casesMissingGeneratedSteps,
    casesMissingG4,
    invalidG4Records,
    warnings,
    notes,
  };
}

function validateG4Record(record: G4Record): string | null {
  if (record.review_type && !["human_review", "ai_estimate"].includes(record.review_type)) {
    return "review_type must be human_review or ai_estimate";
  }
  if (!record.reviewer?.trim()) return "reviewer is empty";
  if (!record.reviewed_at || record.reviewed_at === "YYYY-MM-DD") return "reviewed_at is not filled";
  if (!record.source_artifact || record.source_artifact.includes("<case-id>")) return "source_artifact is not filled";
  const counts = record.counts ?? {};
  const missingCountKeys = requiredG4CountKeys.filter((key) => !(key in counts));
  if (missingCountKeys.length > 0) return `counts missing required keys: ${missingCountKeys.join(", ")}`;
  const countValues = Object.values(counts);
  if (countValues.some((value) => !Number.isInteger(value) || value < 0)) return "counts must be non-negative integers";
  const sum = countValues.reduce((total, value) => total + value, 0);
  if (record.total_manual_edits !== sum) return "total_manual_edits does not match counts sum";
  return null;
}

function printAudit(result: AuditResult): void {
  console.log(`Sprint 1 eval readiness: ${result.pass ? "PASS" : "INCOMPLETE"}`);
  console.log(`Real recording cases: ${result.realCaseCount}/${result.requiredRealCaseCount}`);
  console.log(`Required tags: ${result.requiredTags.join(", ")}`);
  console.log(`Covered tags: ${result.coveredTags.length ? result.coveredTags.join(", ") : "-"}`);
  if (result.notes.length) {
    console.log("Open items:");
    for (const note of result.notes) console.log(`- ${note}`);
  }
  if (result.warnings.length) {
    console.log("Warnings:");
    for (const warning of result.warnings) console.log(`- ${warning}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await auditEvalReadiness();
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printAudit(result);
  }
  if (!result.pass && !args["allow-incomplete"]) {
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
