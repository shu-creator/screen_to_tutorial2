/**
 * 動画の一様サンプリング（Phase 1）
 *
 * ffmpeg 1パスで低解像度グレースケールのフレーム列を取得する。
 * 現行のタイムスタンプごとの ffmpeg -ss 多重起動（プロセスspawn×候補数/フレーム）を
 * 置き換え、デコード1回で差分タイムライン全体を得る。
 */

import { spawn } from "child_process";
import { promisify } from "util";
import { execFile } from "child_process";
import type { GrayFrame } from "./segmentation";

const execFileAsync = promisify(execFile);

export interface SampledTimeline {
  width: number;
  height: number;
  fps: number;
  frames: GrayFrame[];
  durationMs: number;
}

export interface SampleOptions {
  fps?: number;
  width?: number;
  height?: number;
  /** 安全上限（既定: 30分相当） */
  maxFrames?: number;
}

export async function getVideoDurationMs(videoPath: string): Promise<number> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v", "quiet",
      "-show_entries", "format=duration",
      "-of", "csv=p=0",
      videoPath,
    ],
    { timeout: 30_000 },
  );
  const seconds = parseFloat(stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`動画の長さを取得できません: ${videoPath}`);
  }
  return Math.round(seconds * 1000);
}

/**
 * 低解像度グレースケールでフレームを一様サンプリングする。
 * rawvideo を stdout からストリームで受け取り、フレーム境界で分割する。
 */
export async function sampleGrayTimeline(
  videoPath: string,
  options: SampleOptions = {},
): Promise<SampledTimeline> {
  const fps = options.fps ?? 4;
  const width = options.width ?? 320;
  const height = options.height ?? 180;
  const maxFrames = options.maxFrames ?? 30 * 60 * fps;
  const frameSize = width * height;

  const durationMs = await getVideoDurationMs(videoPath);

  const frames: GrayFrame[] = await new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-v", "error",
      "-i", videoPath,
      "-vf", `fps=${fps},scale=${width}:${height},format=gray`,
      "-f", "rawvideo",
      "-",
    ]);

    const collected: GrayFrame[] = [];
    let pending: Buffer = Buffer.alloc(0);
    let aborted = false;
    let stderrText = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      if (aborted) return;
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (pending.length >= frameSize) {
        collected.push({ pixels: pending.subarray(0, frameSize) });
        pending = pending.subarray(frameSize);
        if (collected.length >= maxFrames) {
          aborted = true;
          proc.kill("SIGTERM");
          break;
        }
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderrText += chunk.toString();
    });

    proc.on("error", reject);
    proc.on("close", (code) => {
      if (collected.length === 0) {
        reject(
          new Error(
            `フレームのサンプリングに失敗しました (exit=${code}): ${stderrText.substring(0, 300)}`,
          ),
        );
        return;
      }
      resolve(collected);
    });
  });

  return { width, height, fps, frames, durationMs };
}

/**
 * 指定タイムスタンプのフルサイズフレームをJPEGで抽出する。
 * 代表フレーム/比較用フレームの取り出しに使用（セグメント数に比例した回数のみ実行）。
 */
export async function extractFullFrame(
  videoPath: string,
  timestampMs: number,
  outputPath: string,
): Promise<void> {
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-ss", (timestampMs / 1000).toFixed(3),
      "-i", videoPath,
      "-vframes", "1",
      "-q:v", "2",
      outputPath,
    ],
    { timeout: 30_000 },
  );
}
