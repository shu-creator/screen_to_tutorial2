import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";
import { resolveToLocalFile, storagePut } from "./storage";
import { readBinaryFromSource } from "./storage";
import * as db from "./db";
import { nanoid } from "nanoid";
import { generateSpeechForLongText, type TTSVoice } from "./_core/tts";
import { ENV } from "./_core/env";
import { createTempFilePath, createTempDir, safeTempFileDelete, safeTempDirDelete } from "./tempFileManager";
import {
  buildLegacyRenderableStepsFromArtifact,
  buildStepsArtifactFromDb,
  loadStepsArtifact,
  patchStepArtifact,
  saveStepsArtifact,
  type StepArtifact,
} from "./stepsArtifact";
import { loadEvidenceArtifact } from "./evidence/artifactStore";
import { getVideoDurationMs } from "./evidence/timeline";
import {
  buildClipSegment,
  buildTitleCard,
  concatSegments,
  getVideoResolution,
  planClip,
  resolveAudioMode,
  type AudioMode,
} from "./videoClips";

const execFileAsync = promisify(execFile);

type RenderableStep = {
  id: number;
  frameId: number;
  sortOrder: number;
  title: string;
  operation: string;
  description: string;
  narration: string | null;
  audioUrl: string | null;
  audioKey: string | null;
};

async function loadRenderableStepsForProject(
  projectId: number,
): Promise<{
  steps: RenderableStep[];
  frames: Awaited<ReturnType<typeof db.getFramesByProjectId>>;
}> {
  const frames = await db.getFramesByProjectId(projectId);
  const dbSteps = await db.getStepsByProjectId(projectId);
  const project = await db.getProjectById(projectId);

  let steps: RenderableStep[] = dbSteps.map((step) => ({
    id: step.id,
    frameId: step.frameId,
    sortOrder: step.sortOrder,
    title: step.title,
    operation: step.operation,
    description: step.description,
    narration: step.narration ?? "",
    audioUrl: step.audioUrl ?? null,
    audioKey: step.audioKey ?? null,
  }));

  const artifact = await loadStepsArtifact(projectId);
  if (artifact && artifact.steps.length > 0) {
    steps = buildLegacyRenderableStepsFromArtifact(projectId, artifact, frames);
  } else if (project && dbSteps.length > 0) {
    await saveStepsArtifact(projectId, buildStepsArtifactFromDb(project, frames, dbSteps));
  }

  return { steps, frames };
}

/**
 * ffprobeを使用して音声ファイルの長さ（秒）を取得
 */
async function getAudioDuration(audioPath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "quiet",
      "-show_entries", "format=duration",
      "-of", "csv=p=0",
      audioPath,
    ], { timeout: 30000 });

    const duration = parseFloat(stdout.trim());
    if (isNaN(duration) || duration <= 0) {
      console.warn(`[VideoGenerator] Invalid audio duration: ${stdout}, using default 5s`);
      return 5;
    }
    return duration;
  } catch (error) {
    console.error("[VideoGenerator] Failed to get audio duration:", error);
    return 5; // デフォルト5秒
  }
}

/**
 * テキストから音声を生成（TTS）
 * OpenAI TTS API を使用して実際の音声を生成
 */
async function generateAudio(
  text: string,
  outputPath: string,
  voice: TTSVoice = "nova"
): Promise<{ fallback: boolean }> {
  console.log(`[VideoGenerator] TTS for text: "${text.substring(0, 50)}..."`);

  // OpenAI TTS API を使用して音声を生成
  const result = await generateSpeechForLongText({
    text,
    voice,
    model: ENV.ttsModel,
    speed: 1.0,
    format: "mp3",
  });

  if ("error" in result) {
    console.error(`[VideoGenerator] TTS error: ${result.error}`);
    console.error(`[VideoGenerator] Details: ${result.details}`);

    // TTS が失敗した場合、フォールバックとして無音ファイルを生成
    console.log("[VideoGenerator] Falling back to silent audio");
    const duration = Math.max(3, Math.floor(text.length / 10));
    await execFileAsync("ffmpeg", [
      "-f", "lavfi",
      "-i", "anullsrc=r=44100:cl=mono",
      "-t", duration.toString(),
      "-q:a", "9",
      "-acodec", "libmp3lame",
      outputPath,
    ]);
    return { fallback: true };
  }

  // 音声ファイルを出力パスに保存
  await fs.writeFile(outputPath, result.audioBuffer);
  console.log(`[VideoGenerator] TTS audio saved: ${outputPath}`);
  return { fallback: false };
}

/**
 * プロジェクトの全ステップから音声を生成
 * @param projectId プロジェクトID
 * @param voice 使用する音声（デフォルト: nova）
 */
export async function generateAudioForProject(
  projectId: number,
  voice: TTSVoice = "nova"
): Promise<{ silentFallbackCount: number }> {
  console.log(`[VideoGenerator] Starting audio generation for project ${projectId} with voice: ${voice}`);

  const { steps } = await loadRenderableStepsForProject(projectId);

  if (steps.length === 0) {
    throw new Error("ステップが見つかりません");
  }

  const audioBySortOrder = new Map<number, { audioUrl: string; audioKey: string }>();
  const silentFallbackSortOrders: number[] = [];

  for (const step of steps) {
    if (!step.narration) {
      console.log(`[VideoGenerator] Skipping step ${step.id} - no narration`);
      continue;
    }

    try {
      // 一時ファイルに音声を生成
      const tempAudioPath = createTempFilePath(`audio_${step.id}`, ".mp3");
      const { fallback } = await generateAudio(step.narration, tempAudioPath, voice);
      if (fallback) {
        silentFallbackSortOrders.push(step.sortOrder);
      }

      // S3にアップロード
      const audioBuffer = await fs.readFile(tempAudioPath);
      const fileKey = `projects/${projectId}/audio/${nanoid()}.mp3`;
      const { url: audioUrl } = await storagePut(fileKey, audioBuffer, "audio/mpeg");

      // DBを更新
      if (step.id > 0) {
        await db.updateStep(step.id, {
          audioUrl,
          audioKey: fileKey,
        }).catch(() => {});
      }
      audioBySortOrder.set(step.sortOrder, { audioUrl, audioKey: fileKey });

      // 一時ファイルを削除
      await safeTempFileDelete(tempAudioPath, "VideoGenerator");

      console.log(`[VideoGenerator] Audio generated for step ${step.id}`);
    } catch (error) {
      console.error(`[VideoGenerator] Error generating audio for step ${step.id}:`, error);
    }
  }

  if (audioBySortOrder.size > 0) {
    await patchStepArtifact(projectId, (artifact) => ({
      ...artifact,
      steps: artifact.steps.map((step) => {
        const found = audioBySortOrder.get(step.sort_order);
        if (!found) return step;
        const fallbackWarning = "TTSが失敗し無音音声になっています";
        const warnings = silentFallbackSortOrders.includes(step.sort_order)
          ? Array.from(new Set([...step.warnings, fallbackWarning]))
          : step.warnings;
        return {
          ...step,
          audio_url: found.audioUrl,
          audio_key: found.audioKey,
          warnings,
        };
      }),
    }));
  }

  console.log(`[VideoGenerator] Audio generation complete for project ${projectId}`);
  return { silentFallbackCount: silentFallbackSortOrders.length };
}

/**
 * 静止画+音声のセグメントを生成（クリップ不可時のフォールバック）。
 * concat互換性のため無音でも必ず音声トラックを付ける。
 */
async function buildStillImageSegment(
  imagePath: string,
  audioPath: string | null,
  segmentPath: string,
  targetWidth: number,
  targetHeight: number,
): Promise<void> {
  // concat互換性のため全セグメント共通の解像度へ正規化する
  const normalizeFilter =
    `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,` +
    `pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:color=black`;

  if (audioPath) {
    const audioDuration = await getAudioDuration(audioPath);
    await execFileAsync("ffmpeg", [
      "-y",
      "-loop", "1",
      "-i", imagePath,
      "-i", audioPath,
      "-vf", normalizeFilter,
      "-c:v", "libx264",
      "-tune", "stillimage",
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "44100",
      "-ac", "2",
      "-pix_fmt", "yuv420p",
      "-t", audioDuration.toFixed(3),
      "-r", "30",
      "-vsync", "cfr",
      segmentPath,
    ]);
    return;
  }

  await execFileAsync("ffmpeg", [
    "-y",
    "-loop", "1",
    "-i", imagePath,
    "-f", "lavfi",
    "-i", "anullsrc=r=44100:cl=stereo",
    "-vf", normalizeFilter,
    "-c:v", "libx264",
    "-c:a", "aac",
    "-ar", "44100",
    "-ac", "2",
    "-t", "5",
    "-pix_fmt", "yuv420p",
    "-r", "30",
    segmentPath,
  ]);
}

export interface GenerateVideoOptions {
  /** 音声モード（既定 auto: 発話あり→original / TTSあり→tts / なければ silent） */
  audioMode?: AudioMode;
}

export interface GenerateVideoResult {
  videoUrl: string;
  warnings: string[];
  /** クリップ切り出しに失敗し静止画になったステップ数 */
  stillImageFallbackCount: number;
}

/**
 * Phase 4: 元録画のクリップ + ナレーションで解説動画を生成する。
 * 元録画が取得できない場合は従来の静止画紙芝居に全編フォールバックする。
 */
export async function generateVideo(
  projectId: number,
  options: GenerateVideoOptions = {},
): Promise<GenerateVideoResult> {
  console.log(`[VideoGenerator] Starting video generation for project ${projectId}`);
  const requestedMode: AudioMode = options.audioMode ?? "auto";

  const project = await db.getProjectById(projectId);
  if (!project) {
    throw new Error("プロジェクトが見つかりません");
  }

  const { steps, frames } = await loadRenderableStepsForProject(projectId);

  if (steps.length === 0 || frames.length === 0) {
    throw new Error("ステップまたはフレームが見つかりません");
  }

  const artifact = await loadStepsArtifact(projectId);
  const evidence = await loadEvidenceArtifact(projectId);
  const transcriptPresent = (evidence?.transcript.segments.length ?? 0) > 0;

  // artifactステップを legacy_step_db_id で引けるようにする
  const artifactStepByDbId = new Map<number, StepArtifact>();
  if (artifact) {
    for (const artifactStep of artifact.steps) {
      if (artifactStep.legacy_step_db_id) {
        artifactStepByDbId.set(artifactStep.legacy_step_db_id, artifactStep);
      }
    }
  }
  // セグメントID → 操作開始時刻（クリップのアンカー）
  const transitionStartBySegmentId = new Map<string, number>(
    (evidence?.segments ?? []).map((segment) => [segment.segment_id, segment.transition_start]),
  );

  const warnings: string[] = [];
  let stillImageFallbackCount = 0;

  // 元録画をローカルに解決（取得できなければ全編静止画モード）
  let sourceVideo: { path: string; cleanup: () => Promise<void> } | null = null;
  let videoDurationMs = 0;
  // concat互換性のため全セグメントを共通解像度に正規化する（元録画準拠、無ければFHD）
  let targetWidth = 1920;
  let targetHeight = 1080;
  try {
    sourceVideo = await resolveToLocalFile(project.videoUrl, ".mp4");
    videoDurationMs = await getVideoDurationMs(sourceVideo.path);
    const resolution = await getVideoResolution(sourceVideo.path);
    targetWidth = resolution.width;
    targetHeight = resolution.height;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`元録画を取得できないため静止画モードで生成します: ${message.substring(0, 120)}`);
    sourceVideo = null;
  }

  const tempDir = await createTempDir(`video_${projectId}`);

  try {
    const videoSegments: string[] = [];

    // === イントロ（overviewがある場合のみ） ===
    if (artifact?.overview?.task_title) {
      const introPath = path.join(tempDir, "intro.mp4");
      const built = await buildTitleCard({
        title: artifact.overview.task_title,
        subtitle: `全${steps.length}ステップ`,
        width: targetWidth,
        height: targetHeight,
        outputPath: introPath,
      }).catch(() => null);
      if (built) {
        videoSegments.push(built);
      } else {
        warnings.push("使用可能なフォントが無いためイントロカードをスキップしました");
      }
    }

    for (const step of steps) {
      const frame = frames.find((f) => f.id === step.frameId);
      if (!frame) continue;

      // TTSナレーション音声をローカルへ
      let audioPath: string | null = null;
      if (step.audioUrl) {
        const audioBuffer = await readBinaryFromSource(step.audioUrl);
        audioPath = path.join(tempDir, `audio_${step.id}.mp3`);
        await fs.writeFile(audioPath, audioBuffer);
      }

      const segmentPath = path.join(tempDir, `segment_${step.id}.mp4`);
      const artifactStep = artifactStepByDbId.get(step.id);

      // クリップ切り出し（元録画 + 区間情報がある場合）
      if (sourceVideo && artifactStep) {
        try {
          const firstSegmentId = artifactStep.source_segment_ids[0];
          const transitionStart = firstSegmentId
            ? transitionStartBySegmentId.get(firstSegmentId) ?? null
            : null;
          const plan = planClip(
            { t_start: artifactStep.t_start, t_end: artifactStep.t_end },
            transitionStart,
            videoDurationMs,
            {
              padBeforeMs: ENV.clipPadBeforeMs,
              padAfterMs: ENV.clipPadAfterMs,
              maxDurationMs: ENV.clipMaxDurationMs,
            },
          );
          const mode = resolveAudioMode(requestedMode, transcriptPresent, audioPath !== null);
          const result = await buildClipSegment({
            videoPath: sourceVideo.path,
            plan,
            mode,
            ttsAudioPath: audioPath,
            outputPath: segmentPath,
            targetWidth,
            targetHeight,
          });
          warnings.push(...result.warnings.map((w) => `step ${step.sortOrder + 1}: ${w}`));
          videoSegments.push(segmentPath);
          continue;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(
            `step ${step.sortOrder + 1}: クリップ生成に失敗、静止画にフォールバック: ${message.substring(0, 120)}`,
          );
        }
      }

      // フォールバック: 静止画 + TTS（従来方式）
      stillImageFallbackCount += sourceVideo && artifactStep ? 1 : 0;
      const imageBuffer = await readBinaryFromSource(frame.imageUrl);
      const imagePath = path.join(tempDir, `frame_${step.id}.jpg`);
      await fs.writeFile(imagePath, imageBuffer);
      await buildStillImageSegment(imagePath, audioPath, segmentPath, targetWidth, targetHeight);
      videoSegments.push(segmentPath);
    }

    // === アウトロ（完了条件がある場合のみ） ===
    if (artifact?.overview?.completion_criteria) {
      const outroPath = path.join(tempDir, "outro.mp4");
      const built = await buildTitleCard({
        title: "完了",
        subtitle: artifact.overview.completion_criteria,
        width: targetWidth,
        height: targetHeight,
        outputPath: outroPath,
      }).catch(() => null);
      if (built) videoSegments.push(built);
    }

    if (videoSegments.length === 0) {
      throw new Error("動画セグメントを生成できませんでした");
    }

    const finalVideoPath = path.join(tempDir, "final_video.mp4");
    await concatSegments(videoSegments, tempDir, finalVideoPath);

    const videoBuffer = await fs.readFile(finalVideoPath);
    const fileKey = `projects/${projectId}/videos/${nanoid()}.mp4`;
    const { url: videoUrl } = await storagePut(fileKey, videoBuffer, "video/mp4");

    if (warnings.length > 0) {
      console.warn(`[VideoGenerator] Warnings:\n  ${warnings.join("\n  ")}`);
    }
    console.log(`[VideoGenerator] Video generation complete: ${videoUrl}`);

    return { videoUrl, warnings, stillImageFallbackCount };
  } finally {
    await safeTempDirDelete(tempDir, "VideoGenerator");
    if (sourceVideo) {
      await sourceVideo.cleanup();
    }
  }
}
