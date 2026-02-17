import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";
import { storagePut } from "./storage";
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
} from "./stepsArtifact";

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
): Promise<void> {
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
    return;
  }

  // 音声ファイルを出力パスに保存
  await fs.writeFile(outputPath, result.audioBuffer);
  console.log(`[VideoGenerator] TTS audio saved: ${outputPath}`);
}

/**
 * プロジェクトの全ステップから音声を生成
 * @param projectId プロジェクトID
 * @param voice 使用する音声（デフォルト: nova）
 */
export async function generateAudioForProject(
  projectId: number,
  voice: TTSVoice = "nova"
): Promise<void> {
  console.log(`[VideoGenerator] Starting audio generation for project ${projectId} with voice: ${voice}`);

  const { steps } = await loadRenderableStepsForProject(projectId);

  if (steps.length === 0) {
    throw new Error("ステップが見つかりません");
  }

  const audioBySortOrder = new Map<number, { audioUrl: string; audioKey: string }>();

  for (const step of steps) {
    if (!step.narration) {
      console.log(`[VideoGenerator] Skipping step ${step.id} - no narration`);
      continue;
    }

    try {
      // 一時ファイルに音声を生成
      const tempAudioPath = createTempFilePath(`audio_${step.id}`, ".mp3");
      await generateAudio(step.narration, tempAudioPath, voice);

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
        return {
          ...step,
          audio_url: found.audioUrl,
          audio_key: found.audioKey,
        };
      }),
    }));
  }

  console.log(`[VideoGenerator] Audio generation complete for project ${projectId}`);
}

/**
 * フレームと音声から動画を生成
 */
export async function generateVideo(projectId: number): Promise<string> {
  console.log(`[VideoGenerator] Starting video generation for project ${projectId}`);

  const project = await db.getProjectById(projectId);
  if (!project) {
    throw new Error("プロジェクトが見つかりません");
  }

  const { steps, frames } = await loadRenderableStepsForProject(projectId);

  if (steps.length === 0 || frames.length === 0) {
    throw new Error("ステップまたはフレームが見つかりません");
  }

  // 一時ディレクトリを作成
  const tempDir = await createTempDir(`video_${projectId}`);

  try {
    // 各ステップの画像と音声をダウンロード
    const videoSegments: string[] = [];

    for (const step of steps) {
      const frame = frames.find((f) => f.id === step.frameId);
      if (!frame) continue;

      // 画像をダウンロード
      const imageBuffer = await readBinaryFromSource(frame.imageUrl);
      const imagePath = path.join(tempDir, `frame_${step.id}.jpg`);
      await fs.writeFile(imagePath, imageBuffer);

      // 音声ファイルのパス
      let audioPath: string | null = null;
      if (step.audioUrl) {
        const audioBuffer = await readBinaryFromSource(step.audioUrl);
        audioPath = path.join(tempDir, `audio_${step.id}.mp3`);
        await fs.writeFile(audioPath, audioBuffer);
      }

      // 画像と音声を組み合わせて動画セグメントを作成
      const segmentPath = path.join(tempDir, `segment_${step.id}.mp4`);

      if (audioPath) {
        // 音声の正確な長さを取得
        const audioDuration = await getAudioDuration(audioPath);
        console.log(`[VideoGenerator] Step ${step.id} audio duration: ${audioDuration}s`);

        // 音声がある場合、音声の正確な長さに合わせて画像を表示
        // -t で明示的に長さを指定し、音声と映像のズレを防止
        // セキュリティ: execFileを使用してコマンドインジェクションを防止
        await execFileAsync("ffmpeg", [
          "-loop", "1",
          "-i", imagePath,
          "-i", audioPath,
          "-c:v", "libx264",
          "-tune", "stillimage",
          "-c:a", "aac",
          "-b:a", "192k",
          "-ar", "44100",  // サンプルレートを統一
          "-pix_fmt", "yuv420p",
          "-t", audioDuration.toFixed(3),  // 音声の正確な長さを使用
          "-r", "30",  // フレームレートを固定
          "-vsync", "cfr",  // 一定フレームレートで同期
          segmentPath,
        ]);
      } else {
        // 音声がない場合、デフォルトで5秒間表示
        // セキュリティ: execFileを使用してコマンドインジェクションを防止
        await execFileAsync("ffmpeg", [
          "-loop", "1",
          "-i", imagePath,
          "-c:v", "libx264",
          "-t", "5",
          "-pix_fmt", "yuv420p",
          "-r", "30",  // フレームレートを固定
          "-vf", "scale=1920:1080",
          segmentPath,
        ]);
      }

      videoSegments.push(segmentPath);
    }

    // すべてのセグメントを結合
    const concatListPath = path.join(tempDir, "concat_list.txt");
    const concatContent = videoSegments.map((seg) => `file '${seg}'`).join("\n");
    await fs.writeFile(concatListPath, concatContent);

    const finalVideoPath = path.join(tempDir, "final_video.mp4");
    // セキュリティ: execFileを使用してコマンドインジェクションを防止
    // 再エンコードで音声同期を確保（-c copyだとズレが発生する場合がある）
    await execFileAsync("ffmpeg", [
      "-f", "concat",
      "-safe", "0",
      "-i", concatListPath,
      "-c:v", "libx264",
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "44100",
      "-r", "30",
      "-vsync", "cfr",
      "-async", "1",  // 音声同期を強制
      "-pix_fmt", "yuv420p",
      finalVideoPath,
    ], { timeout: 600000 });  // 10分のタイムアウト

    // S3にアップロード
    const videoBuffer = await fs.readFile(finalVideoPath);
    const fileKey = `projects/${projectId}/videos/${nanoid()}.mp4`;
    const { url: videoUrl } = await storagePut(fileKey, videoBuffer, "video/mp4");

    console.log(`[VideoGenerator] Video generation complete: ${videoUrl}`);

    return videoUrl;
  } finally {
    // 一時ディレクトリをクリーンアップ（リトライ付き）
    await safeTempDirDelete(tempDir, "VideoGenerator");
  }
}
