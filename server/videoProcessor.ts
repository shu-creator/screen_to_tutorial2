import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";
import { storagePut } from "./storage";
import * as db from "./db";
import { nanoid } from "nanoid";

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

interface ExtractedFrame {
  frame_number: number;
  timestamp: number;
  filename: string;
  diff_score: number;
}

/**
 * ffmpegを使って動画情報を取得
 */
async function getVideoInfo(videoPath: string): Promise<{ duration: number; fps: number }> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    videoPath,
  ], { timeout: 30000 });

  const info = JSON.parse(stdout);
  const videoStream = info.streams?.find((s: { codec_type: string }) => s.codec_type === "video");

  const duration = parseFloat(info.format?.duration || "0");
  let fps = 30; // デフォルト値

  if (videoStream?.r_frame_rate) {
    const [num, den] = videoStream.r_frame_rate.split("/").map(Number);
    if (den > 0) fps = num / den;
  }

  return { duration, fps };
}

/**
 * ベストフレーム選択: 複数候補から最もシャープなフレームを選択
 *
 * シーン変化検出は遷移の「瞬間」を検知するため、
 * 取得したフレームが遷移途中（半透明・ぼやけ）になることがある。
 * 少し遅れた複数タイムスタンプでフレームを抽出し、
 * JPEGファイルサイズ（鮮明な画像ほど大きい）で最良を選択する。
 */
async function extractBestFrame(
  videoPath: string,
  timestamp: number,
  outputPath: string,
  duration: number
): Promise<void> {
  // 最初のフレーム（0秒付近）はオフセット不要
  if (timestamp < 0.1) {
    await execFileAsync("ffmpeg", [
      "-ss", "0",
      "-i", videoPath,
      "-vframes", "1",
      "-q:v", "2",
      "-y",
      outputPath,
    ], { timeout: 30000 });
    return;
  }

  // シーン変化後の複数候補を抽出して比較
  const offsets = [0.3, 0.6, 1.0];
  const candidates: Array<{ path: string; size: number }> = [];

  for (const offset of offsets) {
    const candidateTime = Math.min(timestamp + offset, duration - 0.1);
    if (candidateTime <= 0) continue;

    const candidatePath = outputPath.replace(".jpg", `_c${offset.toFixed(1)}.jpg`);

    try {
      await execFileAsync("ffmpeg", [
        "-ss", candidateTime.toString(),
        "-i", videoPath,
        "-vframes", "1",
        "-q:v", "2",
        "-y",
        candidatePath,
      ], { timeout: 30000 });

      const stats = await fs.stat(candidatePath);
      candidates.push({ path: candidatePath, size: stats.size });
    } catch {
      // 候補の抽出に失敗した場合はスキップ
    }
  }

  if (candidates.length === 0) {
    // フォールバック: 元のタイムスタンプで抽出
    await execFileAsync("ffmpeg", [
      "-ss", timestamp.toString(),
      "-i", videoPath,
      "-vframes", "1",
      "-q:v", "2",
      "-y",
      outputPath,
    ], { timeout: 30000 });
    return;
  }

  // 最もファイルサイズが大きい（=最も鮮明な）フレームを選択
  candidates.sort((a, b) => b.size - a.size);
  const best = candidates[0];

  await fs.rename(best.path, outputPath);

  // 他の候補を削除
  for (const c of candidates) {
    if (c.path !== best.path) {
      await fs.unlink(c.path).catch(() => {});
    }
  }
}

/**
 * ffmpegを使ってシーン検出でキーフレームを抽出
 */
async function extractFramesWithFFmpeg(
  videoPath: string,
  outputDir: string,
  options: {
    threshold: number;
    minInterval: number;
    maxFrames: number;
  }
): Promise<ExtractedFrame[]> {
  const { threshold, minInterval, maxFrames } = options;

  // 動画情報を取得
  const { duration, fps } = await getVideoInfo(videoPath);
  console.log(`[VideoProcessor] Video info: duration=${duration}s, fps=${fps}`);

  // シーン検出の閾値を変換（0-100 → 0-1）
  const sceneThreshold = Math.max(0.01, Math.min(0.5, threshold / 100));

  // 最小間隔を秒に変換
  const minIntervalSec = minInterval / fps;

  // シーン検出でフレームを抽出
  // select フィルターで scene 検出し、フレームを出力
  const selectFilter = `select='gt(scene,${sceneThreshold})',showinfo`;

  console.log(`[VideoProcessor] Running ffmpeg with scene detection threshold: ${sceneThreshold}`);

  try {
    // まずシーン検出を実行してタイムスタンプを取得
    const { stderr: sceneOutput } = await execFileAsync("ffmpeg", [
      "-i", videoPath,
      "-vf", selectFilter,
      "-vsync", "vfr",
      "-f", "null",
      "-",
    ], { timeout: 300000, maxBuffer: 50 * 1024 * 1024 });

    // showinfo出力からタイムスタンプを抽出
    const timestamps: number[] = [0]; // 最初のフレームは常に含める
    const lines = sceneOutput.split("\n");

    for (const line of lines) {
      const ptsTimeMatch = line.match(/pts_time:(\d+\.?\d*)/);
      if (ptsTimeMatch) {
        const time = parseFloat(ptsTimeMatch[1]);
        const lastTime = timestamps[timestamps.length - 1];

        // 最小間隔をチェック
        if (time - lastTime >= minIntervalSec) {
          timestamps.push(time);

          if (timestamps.length >= maxFrames) {
            console.log(`[VideoProcessor] Reached max frames limit: ${maxFrames}`);
            break;
          }
        }
      }
    }

    console.log(`[VideoProcessor] Found ${timestamps.length} scene changes`);

    // タイムスタンプが少ない場合、定期的なフレームを追加
    if (timestamps.length < 5 && duration > 0) {
      console.log(`[VideoProcessor] Few scenes detected, adding regular interval frames`);
      const interval = Math.max(2, duration / Math.min(maxFrames, 20)); // 2秒間隔以上
      for (let t = interval; t < duration - 1; t += interval) {
        if (!timestamps.some(ts => Math.abs(ts - t) < minIntervalSec)) {
          timestamps.push(t);
        }
        if (timestamps.length >= maxFrames) break;
      }
      timestamps.sort((a, b) => a - b);
    }

    // 各タイムスタンプでフレームを抽出（ベストフレーム選択付き）
    const frames: ExtractedFrame[] = [];

    for (let i = 0; i < timestamps.length && i < maxFrames; i++) {
      const timestamp = timestamps[i];
      const filename = `frame_${String(i).padStart(6, "0")}.jpg`;
      const outputPath = path.join(outputDir, filename);

      await extractBestFrame(videoPath, timestamp, outputPath, duration);

      frames.push({
        frame_number: Math.round(timestamp * fps),
        timestamp: Math.round(timestamp * 1000), // ミリ秒
        filename,
        diff_score: Math.round(sceneThreshold * 100),
      });

      console.log(`[VideoProcessor] Extracted best frame ${i + 1}/${timestamps.length} at ${timestamp.toFixed(2)}s`);
    }

    return frames;
  } catch (error) {
    console.error(`[VideoProcessor] FFmpeg error:`, error);

    // フォールバック: 定期的なフレーム抽出
    console.log(`[VideoProcessor] Falling back to regular interval extraction`);
    return extractFramesAtIntervals(videoPath, outputDir, duration, fps, maxFrames, minInterval);
  }
}

/**
 * フォールバック: 定期的な間隔でフレームを抽出
 */
async function extractFramesAtIntervals(
  videoPath: string,
  outputDir: string,
  duration: number,
  fps: number,
  maxFrames: number,
  minInterval: number
): Promise<ExtractedFrame[]> {
  const minIntervalSec = minInterval / fps;
  const interval = Math.max(minIntervalSec, duration / maxFrames);
  const frames: ExtractedFrame[] = [];

  for (let t = 0; t < duration && frames.length < maxFrames; t += interval) {
    const filename = `frame_${String(frames.length).padStart(6, "0")}.jpg`;
    const outputPath = path.join(outputDir, filename);

    try {
      await execFileAsync("ffmpeg", [
        "-ss", t.toString(),
        "-i", videoPath,
        "-vframes", "1",
        "-q:v", "2",
        "-y",
        outputPath,
      ], { timeout: 30000 });

      frames.push({
        frame_number: Math.round(t * fps),
        timestamp: Math.round(t * 1000),
        filename,
        diff_score: 0,
      });

      console.log(`[VideoProcessor] Extracted frame ${frames.length} at ${t.toFixed(2)}s`);
    } catch (err) {
      console.warn(`[VideoProcessor] Failed to extract frame at ${t}s:`, err);
    }
  }

  return frames;
}

/**
 * 動画からキーフレームを抽出し、S3にアップロードしてDBに保存
 */
export async function processVideo(
  projectId: number,
  videoUrl: string,
  options: {
    threshold?: number;
    minInterval?: number;
    maxFrames?: number;
  } = {}
): Promise<void> {
  const { threshold = 5.0, minInterval = 30, maxFrames = 100 } = options;

  // 進捗: 処理開始
  await db.updateProjectProgress(projectId, 0, "動画処理を開始しています...");

  // 一時ディレクトリを作成
  const tempDir = path.join("/tmp", `frames_${projectId}_${Date.now()}`);
  await fs.mkdir(tempDir, { recursive: true });

  // 動画をダウンロード（URLの場合）
  const videoPath = path.join(tempDir, "video.mp4");
  console.log(`[VideoProcessor] Downloading video from: ${videoUrl}`);
  await downloadFile(videoUrl, videoPath);

  // ダウンロードしたファイルの検証
  const videoStats = await fs.stat(videoPath);
  console.log(`[VideoProcessor] Video downloaded to: ${videoPath}, size: ${videoStats.size} bytes`);

  if (videoStats.size === 0) {
    throw new Error("ダウンロードした動画ファイルが空です。URLが正しいか確認してください。");
  }

  try {
    // 進捗: フレーム抽出開始
    await db.updateProjectProgress(projectId, 10, "動画からフレームを抽出しています...");

    // ffmpegでフレームを抽出
    console.log(`[VideoProcessor] Extracting frames with ffmpeg...`);
    const frames = await extractFramesWithFFmpeg(videoPath, tempDir, {
      threshold,
      minInterval,
      maxFrames,
    });

    if (frames.length === 0) {
      throw new Error("フレームを抽出できませんでした。動画ファイルが正しいか確認してください。");
    }

    console.log(`[VideoProcessor] Extracted ${frames.length} frames`);

    // 進捗: フレーム抽出完了
    await db.updateProjectProgress(projectId, 30, `${frames.length}個のフレームを抽出しました`);

    // 各フレームをS3にアップロードしてDBに保存
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];

      // セキュリティ: パストラバーサル対策
      const sanitizedFilename = path.basename(frame.filename);
      if (sanitizedFilename !== frame.filename || sanitizedFilename.includes("..")) {
        throw new Error(`不正なファイル名が検出されました: ${frame.filename}`);
      }
      const framePath = path.join(tempDir, sanitizedFilename);

      // 画像ファイルを読み込み
      const imageBuffer = await fs.readFile(framePath);

      // S3にアップロード
      const fileKey = `projects/${projectId}/frames/${nanoid()}.jpg`;
      const { url: imageUrl } = await storagePut(fileKey, imageBuffer, "image/jpeg");

      // DBに保存
      await db.createFrame({
        projectId,
        frameNumber: frame.frame_number,
        timestamp: frame.timestamp,
        imageUrl,
        imageKey: fileKey,
        diffScore: frame.diff_score,
        sortOrder: i,
      });

      // 進捗: フレームアップロード（30% → 70%）
      const uploadProgress = 30 + Math.floor((i + 1) / frames.length * 40);
      await db.updateProjectProgress(projectId, uploadProgress, `フレームをアップロード中 (${i + 1}/${frames.length})`);

      console.log(`[VideoProcessor] Uploaded frame ${i + 1}/${frames.length}`);
    }

    // 進捗: フレーム処理完了
    await db.updateProjectProgress(projectId, 70, "フレームの処理が完了しました");

    console.log(`[VideoProcessor] Processing complete for project ${projectId}`);
  } catch (error) {
    // エラーの種類を判定して適切なメッセージを生成
    let errorMessage = "動画処理中にエラーが発生しました";

    // 元のエラーメッセージをログに記録
    const originalError = error instanceof Error ? error.message : String(error);
    console.error(`[VideoProcessor] Original error: ${originalError}`);

    if (error instanceof Error) {
      const msg = error.message.toLowerCase();

      if (msg.includes("no such file") || msg.includes("enoent")) {
        errorMessage = "動画ファイルが見つかりません。ファイルが削除されたか、アップロードが完了していない可能性があります。";
      } else if (msg.includes("invalid") || msg.includes("corrupt") || msg.includes("decode")) {
        errorMessage = "動画ファイルが破損しているか、対応していない形式です。MP4、MOV、AVI形式の動画を使用してください。";
      } else if (msg.includes("timeout") || msg.includes("timed out")) {
        errorMessage = "処理がタイムアウトしました。動画ファイルが大きすぎるか、複雑すぎる可能性があります。";
      } else if (msg.includes("permission") || msg.includes("eacces")) {
        errorMessage = "ファイルのアクセス権限がありません。サーバーの設定を確認してください。";
      } else if (msg.includes("ffmpeg") || msg.includes("ffprobe")) {
        errorMessage = `ffmpegエラー: ${error.message.substring(0, 150)}`;
      } else {
        // デフォルト: エラーメッセージの最初の150文字を含める
        errorMessage = `動画処理中にエラーが発生しました: ${error.message.substring(0, 150)}`;
      }
    }

    console.error(`[VideoProcessor] Error: ${errorMessage}`);
    throw new Error(errorMessage);
  } finally {
    // 一時ディレクトリをクリーンアップ（リトライ付き）
    await cleanupTempDir(tempDir, "VideoProcessor");
  }
}

/**
 * ローカルファイルをダウンロード（URLまたはローカルパスから）
 */
export async function downloadFile(source: string, destination: string): Promise<void> {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    // URLからダウンロード
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.statusText}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(destination, buffer);
  } else {
    // ローカルファイルをコピー
    await fs.copyFile(source, destination);
  }
}
