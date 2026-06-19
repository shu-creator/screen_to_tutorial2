#!/usr/bin/env tsx
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";

const repoRoot = path.resolve(import.meta.dirname, "..");

const countKeys = [
  "title_edits",
  "description_edits",
  "narration_edits",
  "timing_edits",
  "citation_edits",
  "step_structure_edits",
  "export_artifact_edits",
  "other_edits",
] as const;

type CountKey = typeof countKeys[number];
const recordsDir = path.join(repoRoot, "eval", "g4", "records");

type Options = {
  caseId?: string;
  reviewer?: string;
  reviewedAt?: string;
  sourceArtifact?: string;
  out?: string;
  notes: string;
  blockingIssues: string[];
  exportedArtifacts: string[];
  counts: Record<CountKey, number>;
  dryRun: boolean;
  overwrite: boolean;
  confirmHumanReview: boolean;
};

export type G4Record = {
  version: 1;
  case_id: string;
  review_type: "human_review";
  reviewer: string;
  reviewed_at: string;
  source_artifact: string;
  source_artifact_sha256: string;
  exported_artifacts: string[];
  counts: Record<CountKey, number>;
  total_manual_edits: number;
  blocking_issues: string[];
  notes: string;
};

function defaultCounts(): Record<CountKey, number> {
  return Object.fromEntries(countKeys.map((key) => [key, 0])) as Record<CountKey, number>;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    notes: "",
    blockingIssues: [],
    exportedArtifacts: [],
    counts: defaultCounts(),
    dryRun: false,
    overwrite: false,
    confirmHumanReview: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") {
      continue;
    } else if (arg === "--case") {
      options.caseId = requireValue(arg, next);
      i += 1;
    } else if (arg === "--reviewer") {
      options.reviewer = requireValue(arg, next);
      i += 1;
    } else if (arg === "--reviewed-at") {
      options.reviewedAt = requireValue(arg, next);
      i += 1;
    } else if (arg === "--source-artifact") {
      options.sourceArtifact = requireValue(arg, next);
      i += 1;
    } else if (arg === "--out") {
      options.out = requireValue(arg, next);
      i += 1;
    } else if (arg === "--notes") {
      options.notes = requireValue(arg, next);
      i += 1;
    } else if (arg === "--blocking-issue") {
      options.blockingIssues.push(requireValue(arg, next));
      i += 1;
    } else if (arg === "--exported-artifact") {
      options.exportedArtifacts.push(requireValue(arg, next));
      i += 1;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--overwrite") {
      options.overwrite = true;
    } else if (arg === "--confirm-human-review") {
      options.confirmHumanReview = true;
    } else if (countKeys.some((key) => arg === `--${key}`)) {
      const key = arg.slice(2) as CountKey;
      options.counts[key] = parseCount(arg, requireValue(arg, next));
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function requireValue(arg: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
  return value;
}

function parseCount(arg: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${arg} must be a non-negative integer`);
  return parsed;
}

function printHelp(): void {
  console.log(`Usage:
  pnpm g4:record -- --case <case-id> --reviewer <name> --reviewed-at YYYY-MM-DD \\
    --confirm-human-review [--dry-run] [--overwrite] [count flags...]

Count flags:
  --title_edits N --description_edits N --narration_edits N --timing_edits N
  --citation_edits N --step_structure_edits N --export_artifact_edits N --other_edits N

This command writes a G4 human_review record only when --confirm-human-review is present.
Use --dry-run to print the record without writing it.
`);
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return hash.digest("hex");
}

function rel(filePath: string): string {
  return path.relative(repoRoot, filePath);
}

function resolveRepoPath(filePath: string): string {
  return path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(repoRoot, filePath);
}

async function autoExportedArtifacts(caseId: string): Promise<string[]> {
  const exportDir = path.join(repoRoot, "eval", "results", "export-qa", caseId);
  const names = [
    `${caseId}.pptx`,
    `${caseId}.mp4`,
    "qa-summary.json",
  ];
  const artifacts: string[] = [];
  for (const name of names) {
    const filePath = path.join(exportDir, name);
    if (await fileExists(filePath)) artifacts.push(rel(filePath));
  }
  return artifacts;
}

export async function buildG4Record(options: Options): Promise<{ record: G4Record; outPath: string }> {
  if (!options.caseId) throw new Error("--case is required");
  if (/[/\\]/.test(options.caseId)) throw new Error(`--case must not contain path separators: ${options.caseId}`);
  if (!options.reviewer?.trim()) throw new Error("--reviewer is required");
  if (!options.reviewedAt?.trim()) throw new Error("--reviewed-at is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.reviewedAt)) throw new Error("--reviewed-at must be YYYY-MM-DD");
  if (!options.confirmHumanReview) {
    throw new Error("--confirm-human-review is required to write a human_review G4 record");
  }

  const sourceArtifact = options.sourceArtifact ?? `eval/results/generated/${options.caseId}/steps.json`;
  const sourcePath = resolveRepoPath(sourceArtifact);
  if (!(await fileExists(sourcePath))) throw new Error(`source artifact not found: ${sourceArtifact}`);
  const sourceSha256 = await sha256File(sourcePath);
  const exportedArtifacts = options.exportedArtifacts.length > 0
    ? options.exportedArtifacts
    : await autoExportedArtifacts(options.caseId);
  const total = Object.values(options.counts).reduce((sum, value) => sum + value, 0);
  const outPath = resolveRepoPath(options.out ?? `eval/g4/records/${options.caseId}.json`);
  assertRecordOutPath(outPath);

  return {
    outPath,
    record: {
      version: 1,
      case_id: options.caseId,
      review_type: "human_review",
      reviewer: options.reviewer.trim(),
      reviewed_at: options.reviewedAt,
      source_artifact: rel(sourcePath),
      source_artifact_sha256: sourceSha256,
      exported_artifacts: exportedArtifacts,
      counts: options.counts,
      total_manual_edits: total,
      blocking_issues: options.blockingIssues,
      notes: options.notes,
    },
  };
}

export function assertRecordOutPath(outPath: string): void {
  if (!outPath.startsWith(`${recordsDir}${path.sep}`)) {
    throw new Error(`G4 record output must be inside eval/g4/records: ${outPath}`);
  }
}

export async function writeG4Record(outPath: string, record: G4Record, overwrite: boolean): Promise<void> {
  assertRecordOutPath(outPath);
  if ((await fileExists(outPath)) && !overwrite) {
    throw new Error(`G4 record already exists: ${rel(outPath)}. Use --overwrite after confirming replacement.`);
  }
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(record, null, 2)}\n`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { record, outPath } = await buildG4Record(options);
  const output = `${JSON.stringify(record, null, 2)}\n`;
  if (options.dryRun) {
    console.log(output);
    return;
  }
  await writeG4Record(outPath, record, options.overwrite);
  console.log(`G4 human_review record written: ${rel(outPath)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
