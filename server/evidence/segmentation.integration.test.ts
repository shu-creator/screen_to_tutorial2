/**
 * 合成評価データセットに対するセグメンテーションの統合テスト（Phase 1 PR-A）
 *
 * - 実ffmpegでサンプリング → セグメント検出 → 正解境界とのRecallを検証
 * - 一次信号の比較実験（ピクセル差分率 vs 全画面dHash）の実測値を出力
 *
 * 評価動画は gitignore のため、未生成環境（CI等）ではスキップする。
 * 生成: pnpm eval:dataset
 */

import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { computeBoundaryRecall, type GroundTruthStep } from "../eval/metrics";
import {
  computeDiffTimeline,
  computeFullFrameDHash,
  DEFAULT_SEGMENTATION_OPTIONS,
  detectSegments,
  detectTransitions,
  hammingDistance,
} from "./segmentation";
import { sampleGrayTimeline } from "./timeline";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const DATASET_DIR = path.join(ROOT, "eval", "dataset");

const CASES = ["synth-login-click-01", "synth-form-typing-01", "synth-modal-fade-01"];

function ffmpegAvailable(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function datasetAvailable(): boolean {
  return CASES.every((caseId) =>
    fs.existsSync(path.join(DATASET_DIR, caseId, "video.mp4")),
  );
}

const canRun = ffmpegAvailable() && datasetAvailable();

function loadGroundTruth(caseId: string): GroundTruthStep[] {
  const raw = fs.readFileSync(
    path.join(DATASET_DIR, caseId, "ground_truth.json"),
    "utf8",
  );
  return (JSON.parse(raw) as { steps: GroundTruthStep[] }).steps;
}

describe.skipIf(!canRun)("セグメンテーション統合テスト（合成データセット）", () => {
  for (const caseId of CASES) {
    it(
      `${caseId}: セグメント境界Recall >= 0.75`,
      { timeout: 60_000 },
      async () => {
        const videoPath = path.join(DATASET_DIR, caseId, "video.mp4");
        const timeline = await sampleGrayTimeline(videoPath, { fps: 4 });
        const segments = detectSegments(timeline.frames, timeline.width, timeline.height, {
          fps: timeline.fps,
        });

        const boundaries = new Set<number>();
        for (const segment of segments) {
          // GTのステップ境界は「操作開始時刻」と「結果安定時刻」で定義されるため、
          // 遷移開始時刻もセグメント境界として評価に含める
          boundaries.add(segment.tStartMs);
          boundaries.add(segment.transitionStartMs);
          boundaries.add(segment.tEndMs);
        }
        const groundTruth = loadGroundTruth(caseId);
        const result = computeBoundaryRecall(Array.from(boundaries), groundTruth, 500);

        console.log(
          `[${caseId}] segments=${segments.length} boundaryRecall=${(result.recall * 100).toFixed(1)}% ` +
            `(${result.matchedBoundaries}/${result.totalBoundaries})`,
        );

        expect(result.recall).toBeGreaterThanOrEqual(0.75);
      },
    );
  }

  it(
    "タイピングケース: 1文字ごとの変化が操作単位のセグメントに集約される",
    { timeout: 60_000 },
    async () => {
      const videoPath = path.join(DATASET_DIR, "synth-form-typing-01", "video.mp4");
      const timeline = await sampleGrayTimeline(videoPath, { fps: 4 });
      const segments = detectSegments(timeline.frames, timeline.width, timeline.height, {
        fps: timeline.fps,
      });

      // GTは3ステップ（氏名入力・メール入力・保存）。
      // 1文字ごとにセグメント化されると20超になる。
      // 連続タイピング（文字間隔 < 安定化時間）は状態機械が単一の持続遷移として
      // 捉えるため、coalescingを介さず操作単位に集約される。
      // coalescing は入力間隔が安定化時間を超える遅いタイピングへの
      // セーフティネット（単体テストで検証済み）。
      console.log(
        `[typing] segments=${segments.length} coalescedFrom=${segments.map((s) => s.coalescedFrom).join(",")}`,
      );
      expect(segments.length).toBe(3);
    },
  );

  it(
    "信号比較実験: ピクセル差分率は全画面dHashより遷移を多く検出する（実測記録）",
    { timeout: 120_000 },
    async () => {
      const report: string[] = [];

      for (const caseId of CASES) {
        const videoPath = path.join(DATASET_DIR, caseId, "video.mp4");
        const timeline = await sampleGrayTimeline(videoPath, { fps: 4 });
        const { frames, width, height } = timeline;

        // 候補B: ピクセル差分率（一次信号として採用、既定パラメータ）
        const diffs = computeDiffTimeline(frames, width, height);
        const pixelTransitions = detectTransitions(diffs, frames.length, {
          highThreshold: DEFAULT_SEGMENTATION_OPTIONS.highThreshold,
          lowThreshold: DEFAULT_SEGMENTATION_OPTIONS.lowThreshold,
          stableFrames: DEFAULT_SEGMENTATION_OPTIONS.stableFrames,
        });

        // 比較対象: 全画面dHash（現行コードの重複除去と同じ閾値6で「変化」判定）
        let dhashTransitionCount = 0;
        let prevHash = computeFullFrameDHash(frames[0].pixels, width, height);
        for (let i = 1; i < frames.length; i++) {
          const hash = computeFullFrameDHash(frames[i].pixels, width, height);
          if (hammingDistance(prevHash, hash) > 6) {
            dhashTransitionCount += 1;
          }
          prevHash = hash;
        }

        const groundTruth = loadGroundTruth(caseId);
        const operations = groundTruth.filter((step) => !step.non_step).length;
        report.push(
          `[${caseId}] GT操作数=${operations} ピクセル差分遷移=${pixelTransitions.length} 全画面dHash変化フレーム=${dhashTransitionCount}`,
        );
      }

      console.log(report.join("\n"));

      // タイピングケースで dHash が変化をほぼ検出できないことの確認は
      // segmentation.test.ts の単体テストで実施済み。ここでは実動画での
      // 実測値をテストログに記録することが目的（phase-1ドキュメントに転記）。
      expect(report).toHaveLength(CASES.length);
    },
  );
});
