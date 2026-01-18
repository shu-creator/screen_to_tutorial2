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

    // Pythonスクリプトを実行してフレームを抽出
    const scriptPath = path.join(process.cwd(), "scripts", "extract_frames.py");
    console.log(`[VideoProcessor] Script path: ${scriptPath}`);
    console.log(`[VideoProcessor] CWD: ${process.cwd()}`);

    // スクリプトファイルの存在確認
    try {
      await fs.access(scriptPath);
    } catch {
      throw new Error(`Pythonスクリプトが見つかりません: ${scriptPath}`);
    }

    // セキュリティ: execFileを使用してコマンドインジェクションを防止
    console.log(`[VideoProcessor] Executing: python3 ${scriptPath} with args: ${videoPath} ${tempDir} ${threshold} ${minInterval} ${maxFrames}`);

    let stdout: string;
    let stderr: string;
    try {
      const result = await execFileAsync("python3", [
        scriptPath,
        videoPath,
        tempDir,
        threshold.toString(),
        minInterval.toString(),
        maxFrames.toString(),
      ], { timeout: 300000, maxBuffer: 10 * 1024 * 1024 }); // 5分のタイムアウト、10MB バッファ
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (execError: unknown) {
      // execFileAsyncのエラーにはstdout/stderrが含まれることがある
      const err = execError as { stderr?: string; stdout?: string; message?: string; code?: number };
      const errorStderr = err.stderr || '';
      const errorStdout = err.stdout || '';
      const errorMessage = err.message || 'Unknown error';
      const exitCode = err.code;

      console.error(`[VideoProcessor] Python script failed:`);
      console.error(`[VideoProcessor] Exit code: ${exitCode}`);
      console.error(`[VideoProcessor] stderr: ${errorStderr}`);
      console.error(`[VideoProcessor] stdout: ${errorStdout}`);
      console.error(`[VideoProcessor] message: ${errorMessage}`);

      // より詳細なエラーメッセージを生成
      let detailMessage = errorStderr || errorMessage;
      if (detailMessage.includes('ModuleNotFoundError') || detailMessage.includes('No module named')) {
        throw new Error(`Python依存パッケージが不足しています: ${detailMessage.substring(0, 200)}`);
      } else if (detailMessage.includes('cv2') || detailMessage.includes('opencv')) {
        throw new Error(`OpenCVエラー: ${detailMessage.substring(0, 200)}`);
      } else {
        throw new Error(`Pythonスクリプトエラー (code ${exitCode}): ${detailMessage.substring(0, 300)}`);
      }
    }

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
      } else if (msg.includes("json") || msg.includes("parse")) {
        errorMessage = "フレーム抽出スクリプトの出力が不正です。Python環境を確認してください。";
      } else if (msg.includes("command failed") || msg.includes("python") || msg.includes("spawn")) {
        // より詳細なエラー情報を含める
        errorMessage = `フレーム抽出スクリプトの実行に失敗しました: ${error.message.substring(0, 150)}`;
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
