/**
 * クリップベース動画生成のコア（Phase 4）— DB非依存
 *
 * 元録画から各ステップの区間を切り出し、ナレーション音声と調停して
 * 動画セグメントを作る。videoGenerator.ts がこれをオーケストレーションする。
 *
 * 音声モード:
 *   tts      … クリップ音声をミュートし、TTSナレーションを使用（無音録画の既定）
 *   original … 元録画の該当区間音声をそのまま使用（ナレーション付き録画の既定）
 *   mixed    … 元音声を減衰してTTSを重畳（実験的）
 *   silent   … 無音
 *
 * 長さ調停（tts/mixed）:
 *   TTSがクリップより長い → クリップ末尾を静止フレーム延長（tpad clone）
 *   TTSがクリップより短い → 無音パディングでクリップ長に合わせる（apad）
 */

import { execFile } from "child_process";
import fs from "fs/promises";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export type AudioMode = "auto" | "tts" | "original" | "mixed" | "silent";
export type ResolvedAudioMode = Exclude<AudioMode, "auto">;

export interface ClipPlanOptions {
  padBeforeMs?: number;
  padAfterMs?: number;
  maxDurationMs?: number;
}

export const DEFAULT_CLIP_OPTIONS: Required<ClipPlanOptions> = {
  padBeforeMs: 500,
  padAfterMs: 800,
  maxDurationMs: 20_000,
};

export interface ClipPlan {
  startMs: number;
  endMs: number;
  warnings: string[];
}

/**
 * ステップのクリップ区間を計画する（純関数）。
 * 操作開始時刻（transition_start）があればそこを基準にし、
 * 無ければステップ区間の先頭を使う。
 */
export function planClip(
  step: { t_start: number; t_end: number },
  transitionStartMs: number | null,
  videoDurationMs: number,
  options: ClipPlanOptions = {},
): ClipPlan {
  const opts = { ...DEFAULT_CLIP_OPTIONS, ...options };
  const warnings: string[] = [];

  const anchor = transitionStartMs ?? step.t_start;
  let startMs = Math.max(0, anchor - opts.padBeforeMs);
  let endMs = Math.min(videoDurationMs, step.t_end + opts.padAfterMs);

  if (endMs <= startMs) {
    endMs = Math.min(videoDurationMs, startMs + 1000);
    warnings.push("クリップ区間が不正のため1秒に補正しました");
  }

  if (endMs - startMs > opts.maxDurationMs) {
    // 操作の結果（末尾）を残し、先頭を切り詰める
    startMs = endMs - opts.maxDurationMs;
    warnings.push(
      `クリップが上限(${Math.round(opts.maxDurationMs / 1000)}s)を超えたため先頭を切り詰めました`,
    );
  }

  return { startMs: Math.round(startMs), endMs: Math.round(endMs), warnings };
}

/**
 * 音声モードの自動解決（純関数）。
 * auto は「録画に発話があれば original、TTSナレーション音声があれば tts、なければ silent」。
 */
export function resolveAudioMode(
  requested: AudioMode,
  transcriptPresent: boolean,
  hasTtsAudio: boolean,
): ResolvedAudioMode {
  if (requested !== "auto") return requested;
  if (transcriptPresent) return "original";
  if (hasTtsAudio) return "tts";
  return "silent";
}

export function resolveRequestedAudioMode(globalMode: AudioMode, stepMode: AudioMode | null | undefined): AudioMode {
  return stepMode && stepMode !== "auto" ? stepMode : globalMode;
}

async function getMediaDurationSec(mediaPath: string): Promise<number> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", mediaPath],
    { timeout: 30_000 },
  );
  const duration = parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`メディアの長さを取得できません: ${mediaPath}`);
  }
  return duration;
}

/** 動画の解像度を取得する（偶数に丸める。x264の要件） */
export async function getVideoResolution(
  videoPath: string,
): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v", "quiet",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=p=0",
      videoPath,
    ],
    { timeout: 30_000 },
  );
  const [widthRaw, heightRaw] = stdout.trim().split(",");
  const width = Number(widthRaw);
  const height = Number(heightRaw);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 1920, height: 1080 };
  }
  return { width: width - (width % 2), height: height - (height % 2) };
}

/**
 * 解像度正規化フィルタ。
 * concat demuxer は全セグメント同一ストリームパラメータが前提のため、
 * すべてのセグメント（クリップ・静止画・タイトルカード）を共通解像度へ
 * アスペクト維持+パディングで揃える。
 */
function scalePadFilter(width: number, height: number): string {
  return (
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`
  );
}

async function hasAudioStream(videoPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v", "quiet",
        "-select_streams", "a",
        "-show_entries", "stream=codec_type",
        "-of", "csv=p=0",
        videoPath,
      ],
      { timeout: 30_000 },
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** 全セグメント共通の出力エンコード設定（concat互換性のため統一） */
const COMMON_OUTPUT_ARGS = [
  "-c:v", "libx264",
  "-r", "30",
  "-vsync", "cfr",
  "-pix_fmt", "yuv420p",
  "-c:a", "aac",
  "-b:a", "192k",
  "-ar", "44100",
  "-ac", "2",
];

/**
 * 1ステップ分のクリップセグメントを生成する。
 * すべてのモードで「映像 + 音声トラックあり」のmp4を出力する
 * （音声トラックの欠けたセグメントはconcatを壊すため、無音でも必ず付ける）。
 */
export async function buildClipSegment(options: {
  videoPath: string;
  plan: ClipPlan;
  mode: ResolvedAudioMode;
  /** TTSナレーション音声（tts/mixed時に使用） */
  ttsAudioPath: string | null;
  outputPath: string;
  /** 全セグメント共通の出力解像度（concat互換性のため必須） */
  targetWidth: number;
  targetHeight: number;
}): Promise<{ warnings: string[] }> {
  const { videoPath, plan, mode, ttsAudioPath, outputPath, targetWidth, targetHeight } = options;
  const normalizeFilter = scalePadFilter(targetWidth, targetHeight);
  const warnings: string[] = [...plan.warnings];

  const startSec = (plan.startMs / 1000).toFixed(3);
  const endSec = (plan.endMs / 1000).toFixed(3);
  const clipDurSec = (plan.endMs - plan.startMs) / 1000;

  const sourceHasAudio = await hasAudioStream(videoPath);
  let effectiveMode: ResolvedAudioMode = mode;
  if ((mode === "original" || mode === "mixed") && !sourceHasAudio) {
    effectiveMode = ttsAudioPath ? "tts" : "silent";
    warnings.push(`元録画に音声が無いため ${mode} → ${effectiveMode} に切替`);
  }
  if ((mode === "tts" || mode === "mixed") && !ttsAudioPath) {
    effectiveMode = sourceHasAudio && mode === "mixed" ? "original" : "silent";
    warnings.push(`TTS音声が無いため ${mode} → ${effectiveMode} に切替`);
  }

  const inputArgs = ["-ss", startSec, "-to", endSec, "-i", videoPath];

  if (effectiveMode === "original") {
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        ...inputArgs,
        "-vf", normalizeFilter,
        "-map", "0:v:0",
        "-map", "0:a:0",
        ...COMMON_OUTPUT_ARGS,
        outputPath,
      ],
      { timeout: 300_000 },
    );
    return { warnings };
  }

  if (effectiveMode === "silent") {
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        ...inputArgs,
        "-f", "lavfi",
        "-i", "anullsrc=r=44100:cl=stereo",
        "-vf", normalizeFilter,
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-t", clipDurSec.toFixed(3),
        ...COMMON_OUTPUT_ARGS,
        outputPath,
      ],
      { timeout: 300_000 },
    );
    return { warnings };
  }

  // tts / mixed: TTS長との調停
  const ttsDurSec = await getMediaDurationSec(ttsAudioPath as string);
  const targetDurSec = Math.max(clipDurSec, ttsDurSec);
  const freezeSec = Math.max(0, ttsDurSec - clipDurSec);

  const videoFilter =
    freezeSec > 0.01
      ? `${normalizeFilter},tpad=stop_mode=clone:stop_duration=${freezeSec.toFixed(3)}`
      : normalizeFilter;

  if (effectiveMode === "tts") {
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        ...inputArgs,
        "-i", ttsAudioPath as string,
        "-filter_complex",
        `[0:v]${videoFilter}[v];[1:a]apad[aout]`,
        "-map", "[v]",
        "-map", "[aout]",
        "-t", targetDurSec.toFixed(3),
        ...COMMON_OUTPUT_ARGS,
        outputPath,
      ],
      { timeout: 300_000 },
    );
    return { warnings };
  }

  // mixed: 元音声をダッキングしてTTSを重畳（実験的）
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      ...inputArgs,
      "-i", ttsAudioPath as string,
      "-filter_complex",
      `[0:v]${videoFilter}[v];[0:a]volume=0.25,apad[bg];[1:a]apad[nar];[nar][bg]amix=inputs=2:duration=longest[aout]`,
      "-map", "[v]",
      "-map", "[aout]",
      "-t", targetDurSec.toFixed(3),
      ...COMMON_OUTPUT_ARGS,
      outputPath,
    ],
    { timeout: 300_000 },
  );
  return { warnings };
}

const FONT_CANDIDATES = [
  process.env.SLIDE_FONT_FILE ?? "",
  "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf",
  "/System/Library/Fonts/ヒラギノ角ゴシック W4.ttc",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
].filter(Boolean);

async function findFontFile(): Promise<string | null> {
  for (const candidate of FONT_CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

/**
 * タイトルカード（イントロ/アウトロ）を生成する。
 * 使用可能なフォントが見つからない環境では null を返す（呼び出し側でスキップ）。
 * テキストはエスケープ問題（引用符・コロン等）を避けるため textfile= で渡す。
 */
export async function buildTitleCard(options: {
  title: string;
  subtitle?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  outputPath: string;
}): Promise<string | null> {
  const fontFile = await findFontFile();
  if (!fontFile) {
    return null;
  }

  const duration = options.durationSec ?? 3;
  const width = options.width ?? 1920;
  const height = options.height ?? 1080;

  const os = await import("os");
  const textFiles: string[] = [];
  const writeTextFile = async (text: string): Promise<string> => {
    const filePath = path.join(
      os.tmpdir(),
      `titlecard_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`,
    );
    await fs.writeFile(filePath, text, "utf8");
    textFiles.push(filePath);
    return filePath;
  };

  try {
    const titleFile = await writeTextFile(options.title);
    const filters = [
      `drawtext=fontfile=${fontFile}:textfile=${titleFile}:fontsize=64:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2-40`,
    ];
    if (options.subtitle) {
      const subtitleFile = await writeTextFile(options.subtitle);
      filters.push(
        `drawtext=fontfile=${fontFile}:textfile=${subtitleFile}:fontsize=32:fontcolor=0xDDDDDD:x=(w-text_w)/2:y=(h-text_h)/2+60`,
      );
    }

    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-f", "lavfi",
        "-i", `color=c=0x1f2c44:s=${width}x${height}:d=${duration}`,
        "-f", "lavfi",
        "-i", "anullsrc=r=44100:cl=stereo",
        "-vf", filters.join(","),
        "-t", duration.toString(),
        ...COMMON_OUTPUT_ARGS,
        options.outputPath,
      ],
      { timeout: 120_000 },
    );
    return options.outputPath;
  } finally {
    await Promise.all(textFiles.map((file) => fs.unlink(file).catch(() => {})));
  }
}

/** セグメント群を1本のmp4へ連結する（再エンコードで音声同期を確保） */
export async function concatSegments(
  segmentPaths: string[],
  workDir: string,
  outputPath: string,
): Promise<void> {
  const concatListPath = path.join(workDir, "concat_list.txt");
  const content = segmentPaths.map((segment) => `file '${segment}'`).join("\n");
  await fs.writeFile(concatListPath, content);

  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", concatListPath,
      ...COMMON_OUTPUT_ARGS,
      "-async", "1",
      outputPath,
    ],
    { timeout: 600_000 },
  );
}
