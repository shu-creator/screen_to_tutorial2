#!/usr/bin/env tsx
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const defaultOutdir = path.join(repoRoot, "outputs", "g4-review-packets");

type Options = {
  cases: string[];
  outdir: string;
  overwrite: boolean;
  dryRun: boolean;
  releaseCandidates: boolean;
  missingHumanReview: boolean;
  limit: number | null;
};

type StepsArtifact = {
  steps?: Array<{
    id?: string;
    title?: string;
    operation?: string;
    instruction?: string;
    narration?: string | null;
    t_start?: number;
    t_end?: number;
    needs_review?: boolean;
    review_reasons?: string[];
    warnings?: string[];
    audio_mode?: string;
    cited_ui_labels?: string[];
  }>;
};

type QaSummary = {
  case_id?: string;
  steps?: number;
  needs_review_steps?: number;
  inputs?: {
    video?: string;
    steps?: string;
  };
  integrity?: {
    steps_sha256?: string;
    g4_source_artifact_sha256?: string;
    steps_sha256_matches_g4?: boolean;
    video_sha256?: string;
    meta_video_sha256?: string;
    video_sha256_matches_meta?: boolean;
    warnings?: string[];
  };
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
      speaker_notes_review_warnings?: number;
      extracted_frames?: number;
    };
    video?: {
      duration_sec?: number;
      audio_stream?: boolean;
      audio_content?: string;
      requested_audio_mode?: string;
      resolved_audio_modes?: Record<string, number>;
      drawtext_unavailable_behavior?: string;
      warnings?: string[];
    };
  };
};

type ExistingG4Record = {
  review_type?: string;
  total_manual_edits?: number;
  counts?: Record<string, number>;
  notes?: string;
};

type CaseMeta = {
  case_id?: string;
  synthetic?: boolean;
};

type CandidateRoots = {
  datasetRoot: string;
  exportRoot: string;
  recordsDir: string;
};

export type ReviewPack = {
  caseId: string;
  markdown: string;
  outPath: string;
};

type ReviewPackWriteOptions = {
  overwrite: boolean;
  dryRun: boolean;
  log?: (message: string) => void;
};

export function parseArgs(argv: string[]): Options {
  const options: Options = {
    cases: [],
    outdir: defaultOutdir,
    overwrite: false,
    dryRun: false,
    releaseCandidates: false,
    missingHumanReview: false,
    limit: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") {
      continue;
    } else if (arg === "--case") {
      options.cases.push(requireValue(arg, next));
      i += 1;
    } else if (arg === "--outdir") {
      options.outdir = resolveRepoPath(requireValue(arg, next));
      i += 1;
    } else if (arg === "--overwrite") {
      options.overwrite = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--release-candidates") {
      options.releaseCandidates = true;
    } else if (arg === "--missing-human-review") {
      options.missingHumanReview = true;
    } else if (arg === "--limit") {
      options.limit = parseLimit(requireValue(arg, next));
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const selectorCount = Number(options.releaseCandidates) + Number(options.missingHumanReview);
  if (options.cases.length === 0 && selectorCount === 0) {
    throw new Error("--case is required at least once, unless a selector option is used");
  }
  if (options.cases.length > 0 && selectorCount > 0) {
    throw new Error("--case cannot be combined with selector options");
  }
  if (selectorCount > 1) {
    throw new Error("selector options cannot be combined");
  }
  return options;
}

function requireValue(arg: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
  return value;
}

function parseLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("--limit must be a positive integer");
  return parsed;
}

function printHelp(): void {
  console.log(`Usage:
  pnpm g4:review-pack -- --case <case-id> [--case <case-id> ...] [--outdir outputs/g4-review-packets] [--dry-run] [--overwrite]
  pnpm g4:review-pack -- --release-candidates [--limit 2] [--outdir outputs/g4-review-packets] [--dry-run] [--overwrite]
  pnpm g4:review-pack -- --missing-human-review [--limit N] [--outdir outputs/g4-review-packets] [--dry-run] [--overwrite]

This command creates Markdown worksheets for human G4 review.
With --dry-run, it prints the selected cases and output paths without writing worksheets.
It never writes human_review G4 records; use pnpm g4:record after a real human review.
`);
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function maybeReadJson<T>(filePath: string): Promise<T | null> {
  if (!(await fileExists(filePath))) return null;
  return readJson<T>(filePath);
}

async function sha256File(filePath: string): Promise<string | null> {
  if (!(await fileExists(filePath))) return null;
  const hash = crypto.createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return hash.digest("hex");
}

function resolveRepoPath(filePath: string): string {
  return path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(repoRoot, filePath);
}

function rel(filePath: string): string {
  return path.relative(repoRoot, filePath);
}

function validateCaseId(caseId: string): void {
  if (!caseId.trim()) throw new Error("--case must not be empty");
  if (/[/\\]/.test(caseId)) throw new Error(`--case must not contain path separators: ${caseId}`);
  if (caseId === "." || caseId === "..") throw new Error(`--case must not be a directory reference: ${caseId}`);
}

function assertOutdir(outdir: string): void {
  const resolved = path.resolve(outdir);
  const outputsRoot = path.join(repoRoot, "outputs");
  if (resolved !== outputsRoot && !resolved.startsWith(`${outputsRoot}${path.sep}`)) {
    throw new Error(`--outdir must be inside outputs/: ${outdir}`);
  }
}

function md(value: unknown): string {
  if (value === undefined || value === null || value === "") return "-";
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function bool(value: unknown): string {
  return value === true ? "yes" : value === false ? "no" : "-";
}

function list(items: string[] | undefined): string {
  if (!items || items.length === 0) return "-";
  return items.map((item) => `\`${item}\``).join(", ");
}

function formatSeconds(ms: number | undefined): string {
  return Number.isFinite(ms) ? `${((ms ?? 0) / 1000).toFixed(2)}s` : "-";
}

function formatJson(value: unknown): string {
  if (value === undefined || value === null) return "-";
  return `\`${JSON.stringify(value)}\``;
}

async function readRealCaseIds(datasetRoot = path.join(repoRoot, "eval", "dataset")): Promise<Set<string>> {
  const entries = await fs.readdir(datasetRoot, { withFileTypes: true }).catch(() => []);
  const realCaseIds = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(datasetRoot, entry.name, "meta.json");
    const meta = await maybeReadJson<CaseMeta>(metaPath);
    if (meta?.case_id === entry.name && meta.synthetic === false) realCaseIds.add(meta.case_id);
  }
  return realCaseIds;
}

async function isHumanReviewRecorded(caseId: string, recordsRoot = path.join(repoRoot, "eval", "g4", "records")): Promise<boolean> {
  const g4RecordPath = path.join(recordsRoot, `${caseId}.json`);
  const existingG4 = await maybeReadJson<ExistingG4Record>(g4RecordPath);
  return existingG4?.review_type === "human_review";
}

function isReleaseQaCandidate(summary: QaSummary): boolean {
  const pptx = summary.qa_checks?.pptx;
  const video = summary.qa_checks?.video;
  return Boolean(
    summary.case_id
      && summary.artifacts?.pptx
      && summary.artifacts?.video
      && pptx?.cover_slide === true
      && pptx.completion_slide === true
      && typeof pptx.slide_count === "number"
      && typeof pptx.expected_slide_count === "number"
      && pptx.slide_count > 0
      && pptx.slide_count === pptx.expected_slide_count
      && (video?.duration_sec ?? 0) > 0
      && video?.audio_stream === true,
  );
}

export async function selectReleaseCandidateCases(limit = 2, roots?: Partial<CandidateRoots>): Promise<string[]> {
  const exportRoot = roots?.exportRoot ?? path.join(repoRoot, "eval", "results", "export-qa");
  const datasetRoot = roots?.datasetRoot ?? path.join(repoRoot, "eval", "dataset");
  const g4RecordsDir = roots?.recordsDir ?? path.join(repoRoot, "eval", "g4", "records");
  const entries = await fs.readdir(exportRoot, { withFileTypes: true }).catch(() => []);
  const realCaseIds = await readRealCaseIds(datasetRoot);
  const candidates: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const summaryPath = path.join(exportRoot, entry.name, "qa-summary.json");
    const summary = await maybeReadJson<QaSummary>(summaryPath);
    if (summary?.case_id !== entry.name) continue;
    try {
      if (summary?.case_id) validateCaseId(summary.case_id);
    } catch {
      continue;
    }
    if (!summary?.case_id || !realCaseIds.has(summary.case_id) || !isReleaseQaCandidate(summary)) continue;
    const artifacts = [summary.artifacts?.pptx, summary.artifacts?.video].filter(
      (artifactPath): artifactPath is string => Boolean(artifactPath),
    );
    const artifactsExist = await Promise.all(artifacts.map(async (artifactPath) => fileExists(resolveRepoPath(artifactPath))));
    if (!artifactsExist.every(Boolean)) continue;
    if (await isHumanReviewRecorded(summary.case_id, g4RecordsDir)) continue;
    candidates.push(summary.case_id);
  }

  return candidates.sort().slice(0, limit);
}

export async function selectMissingHumanReviewCases(
  limit = Number.MAX_SAFE_INTEGER,
  roots?: { datasetRoot?: string; generatedRoot?: string; recordsDir?: string },
): Promise<string[]> {
  const datasetRoot = roots?.datasetRoot ?? path.join(repoRoot, "eval", "dataset");
  const generatedRoot = roots?.generatedRoot ?? path.join(repoRoot, "eval", "results", "generated");
  const g4RecordsDir = roots?.recordsDir ?? path.join(repoRoot, "eval", "g4", "records");
  const realCaseIds = await readRealCaseIds(datasetRoot);
  const candidates: string[] = [];

  for (const caseId of Array.from(realCaseIds)) {
    try {
      validateCaseId(caseId);
    } catch {
      continue;
    }
    if (!(await fileExists(path.join(generatedRoot, caseId, "steps.json")))) continue;
    if (await isHumanReviewRecorded(caseId, g4RecordsDir)) continue;
    candidates.push(caseId);
  }

  return candidates.sort().slice(0, limit);
}

export async function buildReviewPack(caseId: string, outdir = defaultOutdir): Promise<ReviewPack> {
  validateCaseId(caseId);
  const outPath = path.join(resolveRepoPath(outdir), `${caseId}.md`);
  const stepsPath = path.join(repoRoot, "eval", "results", "generated", caseId, "steps.json");
  const qaSummaryPath = path.join(repoRoot, "eval", "results", "export-qa", caseId, "qa-summary.json");
  const g4RecordPath = path.join(repoRoot, "eval", "g4", "records", `${caseId}.json`);
  const stepsArtifact = await maybeReadJson<StepsArtifact>(stepsPath);
  const qaSummary = await maybeReadJson<QaSummary>(qaSummaryPath);
  const existingG4 = await maybeReadJson<ExistingG4Record>(g4RecordPath);
  const stepsSha256 = await sha256File(stepsPath);
  const steps = stepsArtifact?.steps ?? [];
  const needsReviewCount = steps.filter((step) => step.needs_review).length;
  const reviewReasons = new Map<string, number>();
  for (const step of steps) {
    for (const reason of step.review_reasons ?? []) {
      reviewReasons.set(reason, (reviewReasons.get(reason) ?? 0) + 1);
    }
  }

  const lines: string[] = [];
  lines.push(`# G4 Human Review Packet: ${caseId}`);
  lines.push("");
  lines.push("> This worksheet is not a `human_review` G4 record. Record `human_review` only after an actual human review and correction pass.");
  lines.push("");
  lines.push("## Source Artifacts");
  lines.push("");
  lines.push(`- Steps: \`${rel(stepsPath)}\`${stepsArtifact ? "" : " (missing)"}`);
  lines.push(`- Steps SHA-256: \`${stepsSha256 ?? "missing"}\``);
  lines.push(`- QA summary: \`${rel(qaSummaryPath)}\`${qaSummary ? "" : " (missing)"}`);
  lines.push(`- Existing G4 record: \`${rel(g4RecordPath)}\`${existingG4 ? ` (${existingG4.review_type ?? "missing review_type"})` : " (missing)"}`);
  lines.push(`- PPTX: \`${qaSummary?.artifacts?.pptx ?? "missing"}\``);
  lines.push(`- Video: \`${qaSummary?.artifacts?.video ?? "missing"}\``);
  lines.push("");
  lines.push("## QA Summary");
  lines.push("");
  lines.push("| Check | Value |");
  lines.push("|---|---|");
  lines.push(`| steps | ${md(qaSummary?.steps ?? steps.length)} |`);
  lines.push(`| needs_review_steps | ${md(qaSummary?.needs_review_steps ?? needsReviewCount)} |`);
  lines.push(`| steps_sha256_matches_g4 | ${bool(qaSummary?.integrity?.steps_sha256_matches_g4)} |`);
  lines.push(`| video_sha256_matches_meta | ${bool(qaSummary?.integrity?.video_sha256_matches_meta)} |`);
  lines.push(`| pptx cover_slide | ${bool(qaSummary?.qa_checks?.pptx?.cover_slide)} |`);
  lines.push(`| pptx completion_slide | ${bool(qaSummary?.qa_checks?.pptx?.completion_slide)} |`);
  lines.push(`| pptx slides | ${md(qaSummary?.qa_checks?.pptx?.slide_count)} / ${md(qaSummary?.qa_checks?.pptx?.expected_slide_count)} |`);
  lines.push(`| speaker_notes_review_warnings | ${md(qaSummary?.qa_checks?.pptx?.speaker_notes_review_warnings)} |`);
  lines.push(`| video duration_sec | ${md(qaSummary?.qa_checks?.video?.duration_sec)} |`);
  lines.push(`| video audio_stream | ${bool(qaSummary?.qa_checks?.video?.audio_stream)} |`);
  lines.push(`| video audio_content | ${md(qaSummary?.qa_checks?.video?.audio_content)} |`);
  lines.push(`| resolved_audio_modes | ${formatJson(qaSummary?.qa_checks?.video?.resolved_audio_modes)} |`);
  lines.push(`| drawtext behavior | ${md(qaSummary?.qa_checks?.video?.drawtext_unavailable_behavior)} |`);
  lines.push("");
  lines.push("## Step Review");
  lines.push("");
  lines.push("| # | time | title | needs_review | reasons | warnings | cited_ui_labels |");
  lines.push("|---:|---|---|---|---|---|---|");
  steps.forEach((step, index) => {
    lines.push(
      `| ${index + 1} | ${formatSeconds(step.t_start)}-${formatSeconds(step.t_end)} | ${md(step.title)} | ${bool(step.needs_review)} | ${list(step.review_reasons)} | ${list(step.warnings)} | ${list(step.cited_ui_labels)} |`,
    );
  });
  if (steps.length === 0) lines.push("| - | - | missing steps artifact | - | - | - | - |");
  lines.push("");
  lines.push("## Human Review Checklist");
  lines.push("");
  lines.push("- [ ] Open the PPTX and confirm cover, each step slide, completion slide, and speaker notes.");
  lines.push("- [ ] Play the MP4 and confirm timing, audio mode, long-step behavior, and drawtext skip behavior.");
  lines.push("- [ ] Review every `needs_review` step and clear or count required edits.");
  lines.push("- [ ] Count edits by G4 category; do not count this worksheet itself as evidence.");
  lines.push("- [ ] Run `pnpm g4:record -- --dry-run ...` first and inspect the JSON.");
  lines.push("");
  lines.push("## G4 Count Worksheet");
  lines.push("");
  lines.push("| category | count | notes |");
  lines.push("|---|---:|---|");
  for (const key of [
    "title_edits",
    "description_edits",
    "narration_edits",
    "timing_edits",
    "citation_edits",
    "step_structure_edits",
    "export_artifact_edits",
    "other_edits",
  ]) {
    lines.push(`| ${key} | 0 |  |`);
  }
  lines.push("");
  lines.push("## Review Signals");
  lines.push("");
  lines.push(`- Existing G4 review_type: \`${existingG4?.review_type ?? "missing"}\``);
  lines.push(`- Existing G4 total_manual_edits: \`${existingG4?.total_manual_edits ?? "missing"}\``);
  lines.push(`- Review reason counts: ${formatJson(Object.fromEntries(Array.from(reviewReasons.entries()).sort()))}`);
  lines.push(`- QA warnings: ${list([...(qaSummary?.integrity?.warnings ?? []), ...(qaSummary?.qa_checks?.video?.warnings ?? [])])}`);
  lines.push("");
  lines.push("## Dry-Run Command Template");
  lines.push("");
  lines.push("```bash");
  lines.push(`pnpm g4:record -- --case ${caseId} \\`);
  lines.push("  --reviewer \"<reviewer-name>\" \\");
  lines.push("  --reviewed-at YYYY-MM-DD \\");
  lines.push("  --confirm-human-review \\");
  lines.push("  --dry-run \\");
  lines.push("  --title_edits 0 --description_edits 0 --narration_edits 0 --timing_edits 0 \\");
  lines.push("  --citation_edits 0 --step_structure_edits 0 --export_artifact_edits 0 --other_edits 0 \\");
  lines.push("  --notes \"Human reviewed PPTX/video/steps and corrected to shippable state.\"");
  lines.push("```");
  lines.push("");

  return { caseId, outPath, markdown: `${lines.join("\n")}\n` };
}

export async function writeReviewPack(pack: ReviewPack, overwrite: boolean): Promise<void> {
  assertOutdir(path.dirname(pack.outPath));
  if ((await fileExists(pack.outPath)) && !overwrite) {
    throw new Error(`review packet already exists: ${rel(pack.outPath)}. Use --overwrite after confirming replacement.`);
  }
  await fs.mkdir(path.dirname(pack.outPath), { recursive: true });
  await fs.writeFile(pack.outPath, pack.markdown);
}

export async function writeOrPreviewReviewPack(
  pack: ReviewPack,
  options: ReviewPackWriteOptions,
): Promise<"dry-run" | "written"> {
  const log = options.log ?? console.log;
  if (options.dryRun) {
    log(`G4 review packet dry-run: ${pack.caseId} -> ${rel(pack.outPath)}`);
    return "dry-run";
  }
  await writeReviewPack(pack, options.overwrite);
  log(`G4 review packet written: ${rel(pack.outPath)}`);
  return "written";
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  assertOutdir(options.outdir);
  if (options.dryRun && options.overwrite) {
    console.warn("warning: --overwrite has no effect with --dry-run");
  }
  const releaseCandidateLimit = options.limit ?? 2;
  const missingHumanReviewLimit = options.limit ?? Number.MAX_SAFE_INTEGER;
  const releaseCandidateCases = options.releaseCandidates
    ? await selectReleaseCandidateCases(releaseCandidateLimit)
    : [];
  const missingHumanReviewCases = options.missingHumanReview
    ? await selectMissingHumanReviewCases(missingHumanReviewLimit)
    : [];
  const cases = options.releaseCandidates
    ? releaseCandidateCases
    : options.missingHumanReview
      ? missingHumanReviewCases
      : options.cases;
  if (options.releaseCandidates && releaseCandidateCases.length === 0) {
    throw new Error("no release candidate cases found from eval/results/export-qa");
  }
  if (options.missingHumanReview && missingHumanReviewCases.length === 0) {
    throw new Error("no real generated cases without human_review G4 found");
  }
  if (options.releaseCandidates && releaseCandidateCases.length < releaseCandidateLimit) {
    console.warn(`warning: selected ${releaseCandidateCases.length}/${releaseCandidateLimit} release candidate cases`);
  }
  if (options.missingHumanReview && options.limit !== null && missingHumanReviewCases.length < options.limit) {
    console.warn(`warning: selected ${missingHumanReviewCases.length}/${options.limit} missing-human-review cases`);
  }
  for (const caseId of cases) {
    const pack = await buildReviewPack(caseId, options.outdir);
    await writeOrPreviewReviewPack(pack, options);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
