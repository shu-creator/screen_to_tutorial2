import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";
import { storagePut } from "./storage";
import * as db from "./db";
import { nanoid } from "nanoid";

const execFileAsync = promisify(execFile);

interface ExtractedFrame {
  frame_number: number;
  timestamp: number;
  filename: string;
  diff_score: number;
}

/**
 * 動画からキーフレームを抽出し、S3にアップロードしてDBに保存
 */
export async function processVideo(
  projectId: number,
  videoPath: string,
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

  try {
    // 進捗: フレーム抽出開始
    await db.updateProjectProgress(projectId, 10, "動画からフレームを抽出しています...");

    // Pythonスクリプトを実行してフレームを抽出
    const scriptPath = path.join(process.cwd(), "scripts", "extract_frames.py");

    // セキュリティ: execFileを使用してコマンドインジェクションを防止
    console.log(`[VideoProcessor] Executing: python3 ${scriptPath} with args`);
    const { stdout, stderr } = await execFileAsync("python3", [
      scriptPath,
      videoPath,
      tempDir,
      threshold.toString(),
      minInterval.toString(),
      maxFrames.toString(),
    ]);

    if (stderr) {
      console.log(`[VideoProcessor] stderr: ${stderr}`);
    }

    // 抽出されたフレーム情報をパース（エラーハンドリング付き）
    let frames: ExtractedFrame[];
    try {
      frames = JSON.parse(stdout);
    } catch (parseError) {
      throw new Error(`フレーム情報のJSONパースに失敗しました: ${parseError instanceof Error ? parseError.message : parseError}`);
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
  } finally {
    // 一時ディレクトリをクリーンアップ
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (err) {
      console.error(`[VideoProcessor] Failed to cleanup temp dir: ${err}`);
    }
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
