import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import {
  buildClipSegment,
  buildTitleCard,
  concatSegments,
  planClip,
  resolveAudioMode,
  resolveRequestedAudioMode,
} from "./videoClips";

describe("planClip", () => {
  const step = { t_start: 5000, t_end: 9000 };

  it("操作開始時刻を基準に前後パディングを付ける", () => {
    const plan = planClip(step, 6000, 60000, { padBeforeMs: 500, padAfterMs: 800 });
    expect(plan.startMs).toBe(5500); // transition 6000 - 500
    expect(plan.endMs).toBe(9800); // t_end 9000 + 800
    expect(plan.warnings).toEqual([]);
  });

  it("transition_start が無ければ t_start を基準にする", () => {
    const plan = planClip(step, null, 60000, { padBeforeMs: 500, padAfterMs: 800 });
    expect(plan.startMs).toBe(4500);
  });

  it("動画の範囲外にはみ出さない", () => {
    const plan = planClip({ t_start: 100, t_end: 59900 }, 100, 60000, {
      padBeforeMs: 500,
      padAfterMs: 800,
      maxDurationMs: 120_000,
    });
    expect(plan.startMs).toBe(0);
    expect(plan.endMs).toBe(60000);
  });

  it("上限超過時は末尾（操作の結果）を残して先頭を切り詰める", () => {
    const plan = planClip({ t_start: 0, t_end: 50000 }, 0, 60000, {
      maxDurationMs: 20000,
      padBeforeMs: 0,
      padAfterMs: 0,
    });
    expect(plan.endMs - plan.startMs).toBe(20000);
    expect(plan.endMs).toBe(50000);
    expect(plan.warnings.length).toBe(1);
  });
});

describe("resolveAudioMode", () => {
  it("auto: 発話あり → original", () => {
    expect(resolveAudioMode("auto", true, true)).toBe("original");
  });
  it("auto: 発話なし+TTSあり → tts", () => {
    expect(resolveAudioMode("auto", false, true)).toBe("tts");
  });
  it("auto: 発話なし+TTSなし → silent", () => {
    expect(resolveAudioMode("auto", false, false)).toBe("silent");
  });
  it("明示指定はそのまま", () => {
    expect(resolveAudioMode("tts", true, true)).toBe("tts");
    expect(resolveAudioMode("silent", true, true)).toBe("silent");
  });
});

describe("resolveRequestedAudioMode", () => {
  it("ステップ単位の明示指定が全体指定より優先される", () => {
    expect(resolveRequestedAudioMode("tts", "original")).toBe("original");
    expect(resolveRequestedAudioMode("silent", "mixed")).toBe("mixed");
  });

  it("ステップ単位がautoまたは未指定なら全体指定を使う", () => {
    expect(resolveRequestedAudioMode("tts", "auto")).toBe("tts");
    expect(resolveRequestedAudioMode("original", undefined)).toBe("original");
  });
});

// --- 統合テスト（ffmpeg + 合成動画が必要） ---

const ROOT = path.resolve(import.meta.dirname, "..");
const SYNTH_VIDEO = path.join(ROOT, "eval", "dataset", "synth-login-click-01", "video.mp4");

function ffmpegAvailable(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function drawtextAvailable(): boolean {
  try {
    const filters = execFileSync("ffmpeg", ["-hide_banner", "-filters"], {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    return /\bdrawtext\b/.test(filters);
  } catch {
    return false;
  }
}

const canRun = ffmpegAvailable() && fs.existsSync(SYNTH_VIDEO);
// drawtext は libfreetype 有効ビルドのみ（Homebrew 配布の ffmpeg には含まれない）
const hasDrawtext = canRun && drawtextAvailable();

function probe(file: string, entries: string, streams?: string): string {
  const args = ["-v", "quiet", "-show_entries", entries, "-of", "csv=p=0", file];
  if (streams) args.splice(2, 0, "-select_streams", streams);
  return execFileSync("ffprobe", args).toString().trim();
}

describe.skipIf(!canRun)("videoClips 統合テスト", () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "clip_test_"));

  it("silentモード: クリップ区間が切り出され無音音声トラックが付く", { timeout: 120_000 }, async () => {
    const out = path.join(workDir, "silent.mp4");
    const { warnings } = await buildClipSegment({
      videoPath: SYNTH_VIDEO,
      plan: { startMs: 2000, endMs: 4500, warnings: [] },
      mode: "silent",
      ttsAudioPath: null,
      outputPath: out,
      // 元録画(1280x720)と異なるターゲットを指定し、正規化が効くことを検証
      targetWidth: 960,
      targetHeight: 540,
    });
    expect(warnings).toEqual([]);
    const duration = parseFloat(probe(out, "format=duration"));
    expect(duration).toBeGreaterThan(2.2);
    expect(duration).toBeLessThan(2.9);
    // 音声トラックが存在する（concat互換性の要件）
    expect(probe(out, "stream=codec_type", "a")).toContain("audio");
    // 解像度がターゲットへ正規化される（concat demuxer は全セグメント同一
    // ストリームパラメータが前提。タイトルカード混在時の破損防止）
    expect(probe(out, "stream=width,height", "v")).toBe("960,540");
  });

  it("ttsモード: TTSがクリップより長い場合は末尾が静止フレームで延長される", { timeout: 120_000 }, async () => {
    // 5秒の擬似ナレーション音声（クリップは2.5秒）
    const tts = path.join(workDir, "tts.mp3");
    execFileSync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
      "-q:a", "9", tts,
    ]);

    const out = path.join(workDir, "tts.mp4");
    await buildClipSegment({
      videoPath: SYNTH_VIDEO,
      plan: { startMs: 2000, endMs: 4500, warnings: [] },
      mode: "tts",
      ttsAudioPath: tts,
      outputPath: out,
      targetWidth: 1280,
      targetHeight: 720,
    });
    const duration = parseFloat(probe(out, "format=duration"));
    // 映像がTTS長（5秒）まで延長される
    expect(duration).toBeGreaterThan(4.8);
    expect(duration).toBeLessThan(5.6);
  });

  it("originalモード: 音声ストリームの無い動画では自動で切替されwarningが付く", { timeout: 120_000 }, async () => {
    const out = path.join(workDir, "orig.mp4");
    const { warnings } = await buildClipSegment({
      videoPath: SYNTH_VIDEO, // 合成動画は無音
      plan: { startMs: 0, endMs: 2000, warnings: [] },
      mode: "original",
      ttsAudioPath: null,
      outputPath: out,
      targetWidth: 1280,
      targetHeight: 720,
    });
    expect(warnings.join()).toContain("切替");
    expect(fs.existsSync(out)).toBe(true);
  });

  it.skipIf(!hasDrawtext)("タイトルカード生成とセグメント連結が動作する（要drawtextフィルタ）", { timeout: 180_000 }, async () => {
    const intro = await buildTitleCard({
      title: "顧客登録の手順",
      subtitle: "全3ステップ",
      durationSec: 2,
      width: 1280,
      height: 720,
      outputPath: path.join(workDir, "intro.mp4"),
    });
    // この環境にはIPAフォントがあるため生成されるはず
    expect(intro).not.toBeNull();

    const clip = path.join(workDir, "clip_for_concat.mp4");
    await buildClipSegment({
      videoPath: SYNTH_VIDEO,
      plan: { startMs: 0, endMs: 2000, warnings: [] },
      mode: "silent",
      ttsAudioPath: null,
      outputPath: clip,
      targetWidth: 1280,
      targetHeight: 720,
    });

    const finalPath = path.join(workDir, "final.mp4");
    await concatSegments([intro as string, clip], workDir, finalPath);

    const duration = parseFloat(probe(finalPath, "format=duration"));
    expect(duration).toBeGreaterThan(3.5); // 2s intro + 2s clip
    expect(probe(finalPath, "stream=codec_type", "a")).toContain("audio");
  });
});
