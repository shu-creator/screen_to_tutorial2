#!/usr/bin/env tsx
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import { pathToFileURL } from "url";

export const repoRoot = path.resolve(import.meta.dirname, "..");
const defaultCaseId = "real-app-workflow-01";

export type PromptCheckOptions = {
  caseId: string;
  explicitCase: boolean;
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
  reviewPacket: boolean;
  stepsPath?: string;
  exportSummaryPath?: string;
  reviewPacketOut?: string;
  overwrite: boolean;
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

type CandidateStepsArtifact = {
  project_id?: number | string;
  generated_at?: string;
  config?: {
    prompt_version?: string;
  };
  overview?: {
    task_title?: string;
    preconditions?: string[];
    completion_criteria?: string;
  };
  steps?: CandidateStep[];
};

type CandidateStep = {
  title?: string;
  t_start?: number;
  t_end?: number;
  needs_review?: boolean;
  review_reasons?: string[];
  warnings?: string[];
  cited_ui_labels?: string[];
};

type ProjectExportSummary = {
  project_id?: number | string;
  requested_audio_mode?: string;
  slide?: {
    path?: string;
    bytes?: number;
    content_check?: {
      status?: string;
      total_slide_count?: number;
      media_image_count?: number;
      slides_with_images?: number;
      expected_step_image_count?: number;
      expected_step_image_count_source?: string;
      notes_review_warning_count?: number;
      placeholder_text_hits?: string[];
      warnings?: string[];
    };
  };
  video?: {
    path?: string;
    bytes?: number;
    warnings?: string[];
    still_image_fallback_count?: number;
  };
};

type ReviewPacketInputs = {
  caseId: string;
  stepsPath: string;
  stepsSha256: string;
  exportSummaryPath: string;
  summary: ProjectExportSummary;
  stepsArtifact: CandidateStepsArtifact;
  pptxSha256: string;
  videoSha256: string;
  worksheetSha256?: string;
};

export function parseArgs(argv: string[]): PromptCheckOptions {
  const options: PromptCheckOptions = {
    caseId: defaultCaseId,
    explicitCase: false,
    runId: timestamp(),
    root: path.join(repoRoot, "outputs", "post-v1-prompt-check"),
    useAudio: "false",
    asrProvider: "none",
    execute: false,
    acceptSideEffects: false,
    reviewPacket: false,
    overwrite: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--":
        break;
      case "--case":
        options.caseId = requireNext(arg, next);
        options.explicitCase = true;
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
      case "--review-packet":
        options.reviewPacket = true;
        break;
      case "--steps":
        options.stepsPath = path.resolve(process.cwd(), requireNext(arg, next));
        i += 1;
        break;
      case "--export-summary":
        options.exportSummaryPath = path.resolve(process.cwd(), requireNext(arg, next));
        i += 1;
        break;
      case "--out":
        options.reviewPacketOut = path.resolve(process.cwd(), requireNext(arg, next));
        i += 1;
        break;
      case "--overwrite":
        options.overwrite = true;
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
  if (options.reviewPacket) {
    if (options.execute || options.acceptSideEffects) {
      throw new Error("--review-packet cannot be combined with --execute or --accept-side-effects");
    }
    if (!options.stepsPath) throw new Error("--review-packet requires --steps");
    if (!options.exportSummaryPath) throw new Error("--review-packet requires --export-summary");
    if (!options.reviewPacketOut) throw new Error("--review-packet requires --out");
    if (!options.explicitCase) throw new Error("--review-packet requires explicit --case");
    return;
  }
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
  if (options.reviewPacket) {
    await writeReviewPacket(options, options.reviewPacketOut);
    return;
  }
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

async function writeReviewPacket(options: PromptCheckOptions, outPath: string | undefined): Promise<void> {
  if (!options.stepsPath || !options.exportSummaryPath) {
    throw new Error("--review-packet requires --steps and --export-summary");
  }
  if (!outPath) throw new Error("--review-packet requires --out");
  const exists = await fileExists(outPath);
  if (exists && !options.overwrite) {
    throw new Error(`refusing to overwrite existing review packet: ${outPath}`);
  }

  const stepsArtifact = await readJson<CandidateStepsArtifact>(options.stepsPath);
  const summary = await readJson<ProjectExportSummary>(options.exportSummaryPath);
  const pptxPath = summary.slide?.path ? resolveRepoPath(summary.slide.path) : null;
  const videoPath = summary.video?.path ? resolveRepoPath(summary.video.path) : null;
  const inputs: ReviewPacketInputs = {
    caseId: options.caseId,
    stepsPath: options.stepsPath,
    stepsSha256: await sha256File(options.stepsPath),
    exportSummaryPath: options.exportSummaryPath,
    summary,
    stepsArtifact,
    pptxSha256: await artifactShaStatus(summary.slide?.path, pptxPath),
    videoSha256: await artifactShaStatus(summary.video?.path, videoPath),
  };

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, formatReviewPacket(inputs), "utf8");
  const worksheetSha256 = await sha256File(outPath);
  console.log(`wrote ${outPath}`);
  console.log(`sha256:${worksheetSha256}`);
}

export function formatReviewPacket(inputs: ReviewPacketInputs): string {
  const { stepsArtifact, summary } = inputs;
  const projectId = summary.project_id ?? stepsArtifact.project_id ?? "-";
  const promptVersion = stepsArtifact.config?.prompt_version ?? "-";
  const title = stepsArtifact.overview?.task_title ?? "-";
  const preconditions = stepsArtifact.overview?.preconditions ?? [];
  const completionCriteria = stepsArtifact.overview?.completion_criteria ?? "-";
  const slideCheck = summary.slide?.content_check;
  const video = summary.video;
  const slidePath = summary.slide?.path ?? "missing";
  const videoPath = video?.path ?? "missing";
  const steps = stepsArtifact.steps ?? [];

  return `${[
    `# Project ${projectId} Human Review Packet`,
    "",
    "> This worksheet is not a `human_review` G4 record. Record `human_review` only after an actual human review of the candidate steps, PPTX, and MP4.",
    "",
    "## Review Target",
    "",
    `- Case: \`${inputs.caseId}\``,
    `- Project: \`${projectId}\``,
    `- Prompt version: \`${promptVersion}\``,
    `- Task title: \`${title}\``,
    "- Preconditions:",
    ...(preconditions.length > 0 ? preconditions.map((item) => `  - \`${item}\``) : ["  - `-`"]),
    `- Completion criteria: \`${completionCriteria}\``,
    "",
    "## Local Artifacts",
    "",
    "These paths are local-only and gitignored.",
    "",
    `- Candidate steps: \`${repoRelative(inputs.stepsPath)}\``,
    `- Candidate steps SHA-256: \`${inputs.stepsSha256}\``,
    `- Export summary: \`${repoRelative(inputs.exportSummaryPath)}\``,
    `- PPTX: \`${slidePath}\``,
    `- PPTX SHA-256: \`${inputs.pptxSha256}\``,
    `- MP4: \`${videoPath}\``,
    `- MP4 SHA-256: \`${inputs.videoSha256}\``,
    "",
    "## Machine QA Summary",
    "",
    "| Check | Value |",
    "|---|---|",
    `| export requested_audio_mode | \`${summary.requested_audio_mode ?? "-"}\` |`,
    `| pptx content_check.status | \`${slideCheck?.status ?? "-"}\` |`,
    `| pptx slides | \`${slideCheck?.total_slide_count ?? "-"}\` |`,
    `| pptx media_image_count | \`${slideCheck?.media_image_count ?? "-"}\` |`,
    `| pptx slides_with_images | \`${slideCheck?.slides_with_images ?? "-"}\` |`,
    `| pptx expected_step_image_count | \`${slideCheck?.expected_step_image_count ?? "-"}\` from \`${slideCheck?.expected_step_image_count_source ?? "-"}\` |`,
    `| pptx notes_review_warning_count | \`${slideCheck?.notes_review_warning_count ?? "-"}\` |`,
    `| pptx placeholder_text_hits | \`${JSON.stringify(slideCheck?.placeholder_text_hits ?? [])}\` |`,
    `| video bytes | \`${video?.bytes ?? "-"}\` |`,
    "| video duration | confirm with player or `ffprobe` |",
    "| video stream | confirm with player or `ffprobe` |",
    `| silent-mode audio stream | ${summary.requested_audio_mode === "silent" ? "confirm silent track" : "n/a"} |`,
    `| video still_image_fallback_count | \`${video?.still_image_fallback_count ?? "-"}\` |`,
    `| video warnings | \`${(video?.warnings ?? []).join("; ") || "-"}\` |`,
    "",
    "## Step Review",
    "",
    "| # | time | title | needs_review | reasons | warnings | cited_ui_labels |",
    "|---:|---|---|---|---|---|---|",
    ...steps.map(formatStepRow),
    "",
    "## Human Review Checklist",
    "",
    "- [ ] Open the candidate steps JSON and confirm the steps match the source recording.",
    "- [ ] Open the PPTX and confirm cover, each step slide, completion slide, screenshots, and speaker notes.",
    "- [ ] Play the MP4 and confirm timing, visual clarity, silent-mode audio behavior, and export completeness.",
    "- [ ] Decide whether any export warnings are acceptable for promotion.",
    "- [ ] Count any edits by G4 category before recording the replacement G4.",
    `- [ ] If accepted, copy the candidate into \`eval/results/generated/${inputs.caseId}/steps.json\` before running \`g4:record\`.`,
    "- [ ] Run `pnpm g4:record -- --dry-run ...` first and inspect the JSON before writing with `--overwrite`.",
    "",
    "## G4 Count Worksheet",
    "",
    "| category | count | notes |",
    "|---|---:|---|",
    "| title_edits | 0 |  |",
    "| description_edits | 0 |  |",
    "| narration_edits | 0 |  |",
    "| timing_edits | 0 |  |",
    "| citation_edits | 0 |  |",
    "| step_structure_edits | 0 |  |",
    "| export_artifact_edits | 0 |  |",
    "| other_edits | 0 |  |",
    "",
    "## Promotion Commands",
    "",
    "Only run these after human acceptance.",
    "",
    "> Replacing the persisted generated artifact invalidates any previous G4 `source_artifact_sha256` for this case. After copying an accepted candidate, record a replacement `human_review` G4 with `--overwrite`; `pnpm v1:release-audit` will fail until that reviewed record matches the new artifact SHA.",
    "",
    "```bash",
    "cp \\",
    `  ${repoRelative(inputs.stepsPath)} \\`,
    `  eval/results/generated/${inputs.caseId}/steps.json`,
    "```",
    "",
    "```bash",
    "pnpm g4:record -- \\",
    `  --case ${inputs.caseId} \\`,
    "  --reviewer \"<reviewer>\" \\",
    "  --reviewed-at YYYY-MM-DD \\",
    "  --confirm-human-review \\",
    "  --dry-run \\",
    "  --title_edits 0 --description_edits 0 --narration_edits 0 --timing_edits 0 \\",
    "  --citation_edits 0 --step_structure_edits 0 --export_artifact_edits 0 --other_edits 0 \\",
    `  --notes "Human reviewed promoted ${promptVersion} candidate and export artifacts."`,
    "```",
    "",
    "If the dry-run output is correct, rerun the same command with `--overwrite` and without `--dry-run`.",
    "",
  ].join("\n")}`;
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

async function fileExists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return hash.digest("hex");
}

async function artifactShaStatus(artifactPath: string | undefined, resolvedPath: string | null): Promise<string> {
  if (!artifactPath || !resolvedPath) return "missing path in export summary";
  if (!(await fileExists(resolvedPath))) return "missing local file";
  return sha256File(resolvedPath);
}

function resolveRepoPath(filePath: string): string {
  return path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(repoRoot, filePath);
}

function repoRelative(filePath: string): string {
  return path.relative(repoRoot, resolveRepoPath(filePath));
}

function formatStepRow(entry: CandidateStep, index: number): string {
  const start = formatMillis(entry.t_start);
  const end = formatMillis(entry.t_end);
  const title = markdownTableCell(entry.title ?? "-");
  const needsReview = entry.needs_review ? "yes" : "no";
  const reasons = markdownTableCell(formatList(entry.review_reasons));
  const warnings = markdownTableCell(formatList(entry.warnings));
  const labels = (entry.cited_ui_labels ?? []).map((label) => `\`${markdownInlineCode(markdownTableCell(label))}\``).join(", ") || "-";
  return `| ${index + 1} | ${start}-${end} | ${title} | ${needsReview} | ${reasons} | ${warnings} | ${labels} |`;
}

function formatMillis(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  const seconds = value / 1000;
  return `${Number.isInteger(seconds) ? seconds : Number(seconds.toFixed(2))}s`;
}

function formatList(values: string[] | undefined): string {
  return values && values.length > 0 ? values.join(", ") : "-";
}

function markdownTableCell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function markdownInlineCode(value: string): string {
  return value.replace(/`/g, "\\`");
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
  --review-packet              Generate a local human-review worksheet from existing artifacts
  --steps <path>               Candidate project_<id>_steps.json for --review-packet
  --export-summary <path>      project_<id>_export_summary.json for --review-packet
  --out <path>                 Output Markdown path for --review-packet
  --overwrite                  Allow --review-packet to overwrite --out

Default mode prints a no-write plan only.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
