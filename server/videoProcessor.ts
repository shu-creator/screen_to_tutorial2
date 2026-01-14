import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";
import { storagePut } from "./storage";
import * as db from "./db";
import { nanoid } from "nanoid";

const execAsync = promisify(exec);

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

  // 一時ディレクトリを作成
  const tempDir = path.join("/tmp", `frames_${projectId}_${Date.now()}`);
  await fs.mkdir(tempDir, { recursive: true });

  try {
    // Pythonスクリプトを実行してフレームを抽出
    const scriptPath = path.join(process.cwd(), "scripts", "extract_frames.py");
    const command = `python3 ${scriptPath} "${videoPath}" "${tempDir}" ${threshold} ${minInterval} ${maxFrames}`;

    console.log(`[VideoProcessor] Executing: ${command}`);
    const { stdout, stderr } = await execAsync(command);

    if (stderr) {
      console.log(`[VideoProcessor] stderr: ${stderr}`);
    }

    // 抽出されたフレーム情報をパース
    const frames: ExtractedFrame[] = JSON.parse(stdout);
    console.log(`[VideoProcessor] Extracted ${frames.length} frames`);

    // 各フレームをS3にアップロードしてDBに保存
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const framePath = path.join(tempDir, frame.filename);

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

      console.log(`[VideoProcessor] Uploaded frame ${i + 1}/${frames.length}`);
    }

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
