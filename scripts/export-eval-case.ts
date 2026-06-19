import { execFile } from "child_process";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { promisify } from "util";
import type PptxGenJS from "pptxgenjs";
import {
  buildClipSegment,
  buildTitleCard,
  concatSegments,
  getVideoResolution,
  planClip,
  resolveAudioMode,
  resolveRequestedAudioMode,
  type AudioMode,
} from "../server/videoClips";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const defaultOutRoot = path.join(repoRoot, "eval", "results", "export-qa");

type RawStepArtifact = {
  step_id: string;
  sort_order: number;
  t_start: number;
  t_end: number;
  representative_frames?: Array<{ timestamp?: number; image_url?: string }>;
  title: string;
  operation: string;
  description: string;
  narration?: string;
  instruction?: string;
  expected_result?: string;
  warnings?: string[];
  needs_review?: boolean;
  review_reasons?: string[];
  audio_mode?: AudioMode;
};

type RawStepsArtifact = {
  overview?: {
    task_title?: string;
    preconditions?: string[];
    completion_criteria?: string;
  } | null;
  steps: RawStepArtifact[];
};

type CaseMeta = {
  case_id?: string;
  has_narration?: boolean;
  video_sha256?: string;
};

type G4Record = {
  source_artifact_sha256?: string;
};

type Options = {
  cases: string[];
  outRoot: string;
  audioMode: AudioMode;
  pptxOnly: boolean;
  videoOnly: boolean;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    cases: [],
    outRoot: defaultOutRoot,
    audioMode: "auto",
    pptxOnly: false,
    videoOnly: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") {
      continue;
    } else if (arg === "--case" && next) {
      options.cases.push(next);
      i += 1;
    } else if (arg === "--outdir" && next) {
      options.outRoot = path.resolve(next);
      i += 1;
    } else if (arg === "--audio-mode" && next) {
      if (!["auto", "tts", "original", "mixed", "silent"].includes(next)) {
        throw new Error(`Unsupported --audio-mode: ${next}`);
      }
      options.audioMode = next as AudioMode;
      i += 1;
    } else if (arg === "--pptx-only") {
      options.pptxOnly = true;
    } else if (arg === "--video-only") {
      options.videoOnly = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.cases.length === 0) {
    throw new Error("--case <case-id> is required");
  }
  if (options.pptxOnly && options.videoOnly) {
    throw new Error("--pptx-only and --video-only cannot be used together");
  }
  return options;
}

function printHelp(): void {
  console.log(`Usage:
  pnpm eval:export-case -- --case <case-id> [--case <case-id> ...]

Options:
  --outdir <path>           Output root. Default: eval/results/export-qa
  --audio-mode <mode>       auto | tts | original | mixed | silent. Default: auto
  --pptx-only               Generate only PPTX
  --video-only              Generate only video
`);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return hash.digest("hex");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sortedSteps(artifact: RawStepsArtifact): RawStepArtifact[] {
  return [...artifact.steps].sort((a, b) => a.sort_order - b.sort_order);
}

async function extractFrame(videoPath: string, timestampMs: number, outputPath: string): Promise<void> {
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-ss",
      (Math.max(0, timestampMs) / 1000).toFixed(3),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      outputPath,
    ],
    { timeout: 120_000 },
  );
}

async function mediaDurationSec(mediaPath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", mediaPath],
      { timeout: 30_000 },
    );
    const duration = Number.parseFloat(stdout.trim());
    return Number.isFinite(duration) ? duration : null;
  } catch {
    return null;
  }
}

async function hasAudioStream(mediaPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v",
        "quiet",
        "-select_streams",
        "a",
        "-show_entries",
        "stream=codec_type",
        "-of",
        "csv=p=0",
        mediaPath,
      ],
      { timeout: 30_000 },
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

function notesForStep(step: RawStepArtifact): string {
  const notes = [
    step.narration ? `Narration: ${step.narration}` : "",
    step.instruction ? `Instruction: ${step.instruction}` : "",
    step.expected_result ? `Expected: ${step.expected_result}` : "",
  ].filter(Boolean);

  if (step.needs_review) {
    const reasons = [
      ...(step.warnings ?? []),
      ...(step.review_reasons ?? []).map((reason) => `reason:${reason}`),
    ];
    notes.unshift(
      `【要レビュー】${reasons.length > 0 ? reasons.join(" / ") : "信頼度が低い生成結果です"}`,
      "配布前にこのステップを確認してください。",
    );
  }
  return notes.join("\n");
}

async function buildPptx(options: {
  caseId: string;
  artifact: RawStepsArtifact;
  videoPath: string;
  outDir: string;
}): Promise<{
  pptxPath: string;
  slideCount: number;
  notesWarningCount: number;
  extractedFrames: number;
  coverSlide: boolean;
  completionSlide: boolean;
}> {
  const { caseId, artifact, videoPath, outDir } = options;
  const framesDir = path.join(outDir, "frames");
  await fs.mkdir(framesDir, { recursive: true });

  const PptxGenJSModule = await import("pptxgenjs");
  const PptxGenJSConstructor = PptxGenJSModule.default;
  const pptx = new PptxGenJSConstructor();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "screen_to_tutorial eval export";
  pptx.subject = caseId;
  pptx.title = artifact.overview?.task_title ?? caseId;
  pptx.company = "screen_to_tutorial";
  pptx.theme = {
    headFontFace: "Arial",
    bodyFontFace: "Arial",
  };

  let slideCount = 0;
  let extractedFrames = 0;
  let notesWarningCount = 0;
  let coverSlide = false;
  let completionSlide = false;

  const addTitle = (slide: ReturnType<PptxGenJS["addSlide"]>, title: string, y = 0.35): void => {
    slide.addText(title, {
      x: 0.55,
      y,
      w: 12.2,
      h: 0.5,
      fontSize: 22,
      bold: true,
      color: "1F2937",
      fit: "shrink",
    });
  };

  const cover = pptx.addSlide();
  slideCount += 1;
  coverSlide = true;
  cover.background = { color: "F8FAFC" };
  addTitle(cover, artifact.overview?.task_title ?? caseId, 0.65);
  cover.addText(`評価ケース: ${caseId}`, {
    x: 0.6,
    y: 1.35,
    w: 12,
    h: 0.4,
    fontSize: 15,
    color: "475569",
  });
  if (artifact.overview?.preconditions?.length) {
    cover.addText(`前提: ${artifact.overview.preconditions.join(" / ")}`, {
      x: 0.6,
      y: 2.05,
      w: 12,
      h: 0.8,
      fontSize: 14,
      color: "334155",
      fit: "shrink",
    });
  }

  for (const step of sortedSteps(artifact)) {
    const slide = pptx.addSlide();
    slideCount += 1;
    const label = `Step ${step.sort_order + 1}`;
    slide.addText(label, {
      x: 0.55,
      y: 0.32,
      w: 1.2,
      h: 0.32,
      fontSize: 11,
      bold: true,
      color: "2563EB",
    });
    addTitle(slide, step.title, 0.68);
    slide.addText(step.operation, {
      x: 0.65,
      y: 1.25,
      w: 4.55,
      h: 0.8,
      fontSize: 18,
      bold: true,
      color: "111827",
      fit: "shrink",
    });
    slide.addText(step.description, {
      x: 0.65,
      y: 2.15,
      w: 4.55,
      h: 2.25,
      fontSize: 13,
      color: "374151",
      valign: "top",
      fit: "shrink",
    });

    const frameTimestamp = step.representative_frames?.[0]?.timestamp ?? step.t_end;
    const framePath = path.join(framesDir, `${String(step.sort_order + 1).padStart(2, "0")}.jpg`);
    await extractFrame(videoPath, frameTimestamp, framePath);
    extractedFrames += 1;
    slide.addImage({ path: framePath, x: 5.55, y: 1.2, w: 7.0, h: 4.55 });
    slide.addText(`${Math.round(step.t_start / 1000)}s-${Math.round(step.t_end / 1000)}s`, {
      x: 5.55,
      y: 5.9,
      w: 2.4,
      h: 0.25,
      fontSize: 10,
      color: "64748B",
    });

    const notes = notesForStep(step);
    if (step.needs_review) notesWarningCount += 1;
    slide.addNotes(notes);
  }

  if (artifact.overview?.completion_criteria) {
    const done = pptx.addSlide();
    slideCount += 1;
    completionSlide = true;
    done.background = { color: "1D4ED8" };
    done.addText("完了", {
      x: 0.8,
      y: 1.5,
      w: 11.7,
      h: 0.7,
      fontSize: 34,
      bold: true,
      color: "FFFFFF",
      align: "center",
    });
    done.addText(artifact.overview.completion_criteria, {
      x: 1.0,
      y: 2.7,
      w: 11.2,
      h: 1.2,
      fontSize: 17,
      color: "FFFFFF",
      align: "center",
      fit: "shrink",
    });
  }

  const pptxPath = path.join(outDir, `${caseId}.pptx`);
  await pptx.writeFile({ fileName: pptxPath });
  return { pptxPath, slideCount, notesWarningCount, extractedFrames, coverSlide, completionSlide };
}

async function buildVideo(options: {
  caseId: string;
  artifact: RawStepsArtifact;
  meta: CaseMeta;
  videoPath: string;
  outDir: string;
  audioMode: AudioMode;
}): Promise<{
  videoPath: string;
  durationSec: number | null;
  audioStream: boolean;
  warnings: string[];
  titleCards: { requested: number; built: number; skipped: number };
  resolvedAudioModes: Record<string, number>;
}> {
  const { caseId, artifact, meta, videoPath, outDir, audioMode } = options;
  const workDir = path.join(outDir, "video-work");
  await fs.mkdir(workDir, { recursive: true });

  const resolution = await getVideoResolution(videoPath);
  const inputDurationSec = await mediaDurationSec(videoPath);
  const inputDurationMs = Math.round((inputDurationSec ?? 0) * 1000);
  const transcriptPresent = meta.has_narration === true;
  const warnings: string[] = [];
  const segments: string[] = [];
  const resolvedAudioModes: Record<string, number> = {};
  let titleCardsRequested = 0;
  let titleCardsBuilt = 0;

  if (audioMode === "tts" || audioMode === "mixed") {
    warnings.push(`${audioMode}: TTS音声入力が無いため、ステップごとにsilent/originalへフォールバックします`);
  }

  const tryTitleCard = async (name: string, title: string, subtitle?: string): Promise<void> => {
    titleCardsRequested += 1;
    const outputPath = path.join(workDir, `${name}.mp4`);
    try {
      const built = await buildTitleCard({
        title,
        subtitle,
        width: resolution.width,
        height: resolution.height,
        outputPath,
      });
      if (built) {
        segments.push(built);
        titleCardsBuilt += 1;
      } else {
        warnings.push(`${name}: title card skipped because no usable font was found`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`${name}: title card skipped: ${message.substring(0, 160)}`);
    }
  };

  if (artifact.overview?.task_title) {
    await tryTitleCard("intro", artifact.overview.task_title, `全${artifact.steps.length}ステップ`);
  }

  for (const step of sortedSteps(artifact)) {
    const planned = planClip(
      { t_start: step.t_start, t_end: step.t_end },
      null,
      inputDurationMs,
    );
    const requested = resolveRequestedAudioMode(audioMode, step.audio_mode);
    const mode = resolveAudioMode(requested, transcriptPresent, false);
    resolvedAudioModes[mode] = (resolvedAudioModes[mode] ?? 0) + 1;
    const outputPath = path.join(workDir, `step-${String(step.sort_order + 1).padStart(2, "0")}.mp4`);
    const result = await buildClipSegment({
      videoPath,
      plan: planned,
      mode,
      ttsAudioPath: null,
      outputPath,
      targetWidth: resolution.width,
      targetHeight: resolution.height,
    });
    warnings.push(...result.warnings.map((warning) => `step ${step.sort_order + 1}: ${warning}`));
    segments.push(outputPath);
  }

  if (artifact.overview?.completion_criteria) {
    await tryTitleCard("outro", "完了", artifact.overview.completion_criteria);
  }

  if (segments.length === 0) {
    throw new Error(
      `No segments to concat for case ${caseId}: no step clips or renderable title cards were produced`,
    );
  }

  const finalPath = path.join(outDir, `${caseId}.mp4`);
  await concatSegments(segments, workDir, finalPath);
  return {
    videoPath: finalPath,
    durationSec: await mediaDurationSec(finalPath),
    audioStream: await hasAudioStream(finalPath),
    warnings,
    titleCards: {
      requested: titleCardsRequested,
      built: titleCardsBuilt,
      skipped: titleCardsRequested - titleCardsBuilt,
    },
    resolvedAudioModes,
  };
}

async function exportCase(caseId: string, options: Options): Promise<void> {
  const caseDir = path.join(repoRoot, "eval", "dataset", caseId);
  const generatedDir = path.join(repoRoot, "eval", "results", "generated", caseId);
  const videoPath = path.join(caseDir, "video.mp4");
  const metaPath = path.join(caseDir, "meta.json");
  const stepsPath = path.join(generatedDir, "steps.json");
  const g4Path = path.join(repoRoot, "eval", "g4", "records", `${caseId}.json`);
  const outDir = path.join(options.outRoot, caseId);

  if (!(await fileExists(videoPath))) throw new Error(`Missing video: ${videoPath}`);
  if (!(await fileExists(stepsPath))) {
    throw new Error(
      `Missing steps artifact: ${stepsPath}. Run pnpm pipeline:generate for this case and place the output at eval/results/generated/${caseId}/steps.json before export QA.`,
    );
  }

  await fs.mkdir(outDir, { recursive: true });
  const artifact = await readJson<RawStepsArtifact>(stepsPath);
  const meta = (await fileExists(metaPath)) ? await readJson<CaseMeta>(metaPath) : {};
  const g4Record = (await fileExists(g4Path)) ? await readJson<G4Record>(g4Path) : null;
  const stepsSha256 = await sha256File(stepsPath);
  const videoSha256 = await sha256File(videoPath);
  const integrityWarnings: string[] = [];
  if (g4Record?.source_artifact_sha256 && g4Record.source_artifact_sha256 !== stepsSha256) {
    integrityWarnings.push(
      `steps sha256 mismatch: G4 expects ${g4Record.source_artifact_sha256}, actual ${stepsSha256}`,
    );
  }
  if (meta.video_sha256 && meta.video_sha256 !== videoSha256) {
    integrityWarnings.push(`video sha256 mismatch: meta expects ${meta.video_sha256}, actual ${videoSha256}`);
  }
  const summary: Record<string, unknown> = {
    case_id: caseId,
    generated_at: new Date().toISOString(),
    inputs: {
      video: path.relative(repoRoot, videoPath),
      steps: path.relative(repoRoot, stepsPath),
    },
    steps: artifact.steps.length,
    needs_review_steps: artifact.steps.filter((step) => step.needs_review).length,
    integrity: {
      steps_sha256: stepsSha256,
      g4_source_artifact_sha256: g4Record?.source_artifact_sha256 ?? null,
      steps_sha256_matches_g4: g4Record?.source_artifact_sha256
        ? g4Record.source_artifact_sha256 === stepsSha256
        : null,
      video_sha256: videoSha256,
      meta_video_sha256: meta.video_sha256 ?? null,
      video_sha256_matches_meta: meta.video_sha256 ? meta.video_sha256 === videoSha256 : null,
      warnings: integrityWarnings,
    },
    artifacts: {},
    qa_checks: {},
  };

  if (!options.videoOnly) {
    const pptx = await buildPptx({ caseId, artifact, videoPath, outDir });
    summary.artifacts = {
      ...(summary.artifacts as Record<string, unknown>),
      pptx: path.relative(repoRoot, pptx.pptxPath),
    };
    summary.qa_checks = {
      ...(summary.qa_checks as Record<string, unknown>),
      pptx: {
        cover_slide: pptx.coverSlide,
        completion_slide: pptx.completionSlide,
        slide_count: pptx.slideCount,
        expected_slide_count: artifact.steps.length + 1 + (artifact.overview?.completion_criteria ? 1 : 0),
        speaker_notes_review_warnings: pptx.notesWarningCount,
        extracted_frames: pptx.extractedFrames,
      },
    };
  }

  if (!options.pptxOnly) {
    const video = await buildVideo({ caseId, artifact, meta, videoPath, outDir, audioMode: options.audioMode });
    summary.artifacts = {
      ...(summary.artifacts as Record<string, unknown>),
      video: path.relative(repoRoot, video.videoPath),
    };
    summary.qa_checks = {
      ...(summary.qa_checks as Record<string, unknown>),
      video: {
        duration_sec: video.durationSec,
        audio_stream: video.audioStream,
        audio_content:
          Object.keys(video.resolvedAudioModes).length === 1 && video.resolvedAudioModes.silent
            ? "synthetic_silence"
            : meta.has_narration
              ? "source_audio"
              : "mixed_or_generated",
        requested_audio_mode: options.audioMode,
        resolved_audio_modes: video.resolvedAudioModes,
        title_cards: video.titleCards,
        drawtext_unavailable_behavior:
          video.titleCards.skipped > 0
            ? "intro/outro title cards are skipped and recorded as warnings; step clips still render"
            : "intro/outro title cards rendered",
        warnings: video.warnings,
      },
    };
  }

  const summaryPath = path.join(outDir, "qa-summary.json");
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`${caseId}: wrote ${path.relative(repoRoot, summaryPath)}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  for (const caseId of options.cases) {
    await exportCase(caseId, options);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
