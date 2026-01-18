import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";
import { storagePut } from "./storage";
import * as db from "./db";
import { nanoid } from "nanoid";
import { generateSpeech, generateSpeechForLongText, type TTSVoice } from "./_core/tts";

const execFileAsync = promisify(execFile);

/**
 * 一時ディレクトリをクリーンアップ（リトライ付き）
 */
async function cleanupTempDir(tempDir: string, context: string): Promise<void> {
  const maxRetries = 3;
  const retryDelay = 1000; // 1秒

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt < maxRetries) {
        console.warn(`[${context}] Cleanup attempt ${attempt} failed, retrying in ${retryDelay}ms: ${tempDir}`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      } else {
        console.error(`[${context}] Failed to cleanup temp dir after ${maxRetries} attempts: ${tempDir}`);
        console.error(`[${context}] Manual cleanup may be required: rm -rf ${tempDir}`);
      }
    }
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
    model: "tts-1",
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

  const steps = await db.getStepsByProjectId(projectId);

  if (steps.length === 0) {
    throw new Error("ステップが見つかりません");
  }

  for (const step of steps) {
    if (!step.narration) {
      console.log(`[VideoGenerator] Skipping step ${step.id} - no narration`);
      continue;
    }

    try {
      // 一時ファイルに音声を生成
      const tempAudioPath = path.join("/tmp", `audio_${step.id}_${Date.now()}.mp3`);
      await generateAudio(step.narration, tempAudioPath, voice);

      // S3にアップロード
      const audioBuffer = await fs.readFile(tempAudioPath);
      const fileKey = `projects/${projectId}/audio/${nanoid()}.mp3`;
      const { url: audioUrl } = await storagePut(fileKey, audioBuffer, "audio/mpeg");

      // DBを更新
      await db.updateStep(step.id, {
        audioUrl,
        audioKey: fileKey,
      });

      // 一時ファイルを削除
      await fs.unlink(tempAudioPath).catch(() => {});

      console.log(`[VideoGenerator] Audio generated for step ${step.id}`);
    } catch (error) {
      console.error(`[VideoGenerator] Error generating audio for step ${step.id}:`, error);
    }
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

  const steps = await db.getStepsByProjectId(projectId);
  const frames = await db.getFramesByProjectId(projectId);

  if (steps.length === 0 || frames.length === 0) {
    throw new Error("ステップまたはフレームが見つかりません");
  }

  // 一時ディレクトリを作成
  const tempDir = path.join("/tmp", `video_${projectId}_${Date.now()}`);
  await fs.mkdir(tempDir, { recursive: true });

  try {
    // 各ステップの画像と音声をダウンロード
    const videoSegments: string[] = [];

    for (const step of steps) {
      const frame = frames.find((f) => f.id === step.frameId);
      if (!frame) continue;

      // 画像をダウンロード
      const imageResponse = await fetch(frame.imageUrl);
      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
      const imagePath = path.join(tempDir, `frame_${step.id}.jpg`);
      await fs.writeFile(imagePath, imageBuffer);

      // 音声ファイルのパス
      let audioPath: string | null = null;
      if (step.audioUrl) {
        const audioResponse = await fetch(step.audioUrl);
        const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
        audioPath = path.join(tempDir, `audio_${step.id}.mp3`);
        await fs.writeFile(audioPath, audioBuffer);
      }

      // 画像と音声を組み合わせて動画セグメントを作成
      const segmentPath = path.join(tempDir, `segment_${step.id}.mp4`);
      
      if (audioPath) {
        // 音声がある場合、音声の長さに合わせて画像を表示
        // セキュリティ: execFileを使用してコマンドインジェクションを防止
        await execFileAsync("ffmpeg", [
          "-loop", "1",
          "-i", imagePath,
          "-i", audioPath,
          "-c:v", "libx264",
          "-tune", "stillimage",
          "-c:a", "aac",
          "-b:a", "192k",
          "-pix_fmt", "yuv420p",
          "-shortest",
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
    await execFileAsync("ffmpeg", [
      "-f", "concat",
      "-safe", "0",
      "-i", concatListPath,
      "-c", "copy",
      finalVideoPath,
    ]);

    // S3にアップロード
    const videoBuffer = await fs.readFile(finalVideoPath);
    const fileKey = `projects/${projectId}/videos/${nanoid()}.mp4`;
    const { url: videoUrl } = await storagePut(fileKey, videoBuffer, "video/mp4");

    console.log(`[VideoGenerator] Video generation complete: ${videoUrl}`);

    return videoUrl;
  } finally {
    // 一時ディレクトリをクリーンアップ（リトライ付き）
    await cleanupTempDir(tempDir, "VideoGenerator");
  }
}
