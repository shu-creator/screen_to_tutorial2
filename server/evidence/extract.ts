/**
 * 証拠抽出オーケストレーター（Phase 1）
 *
 * 動画ファイル → サンプリング → セグメント検出 → 代表フレーム抽出 →
 * OCR / ASR割り当て → evidence.json 相当の構造を組み立てる。
 *
 * このモジュールはDB・ストレージに依存しない（ローカルファイルで完結）。
 * プロジェクトフローへの組み込み（ストレージ保存・frames テーブル同期・
 * frame_id 付与）は videoProcessor 側で行う。
 */

import fs from "fs/promises";
import path from "path";
import { ENV } from "../_core/env";
import { createLogger } from "../_core/logger";
import { hashFile } from "../_core/pipelineCache";
import { extractFrameOcrUnified } from "../_core/ocr";
import { getSharedOcrEngine } from "../_core/ocrEngine";
import {
  transcribeVideoSource,
  type TranscriptionResult,
  type TranscriptSegment,
} from "../_core/asr";
import {
  detectSegments,
  rectsIntersect,
  type NormalizedRect,
  type OperationSegment,
} from "./segmentation";
import { extractFullFrame, sampleGrayTimeline } from "./timeline";
import { EVIDENCE_ARTIFACT_VERSION, type EvidenceArtifact, type EvidenceSegment } from "./types";

const logger = createLogger("Evidence");

export interface ExtractEvidenceOptions {
  /** 代表フレーム等の出力先ディレクトリ */
  framesDir: string;
  sampleFps?: number;
  diffHigh?: number;
  diffLow?: number;
  stableFrames?: number;
  coalesceMaxGapMs?: number;
  asrLeadMs?: number;
  asrProvider?: typeof ENV.asrProvider;
  ocrProvider?: typeof ENV.ocrProvider;
  onProgress?: (ratio: number, message: string) => Promise<void> | void;
}

export interface ExtractedEvidence {
  artifact: EvidenceArtifact;
  /** segment_id → 出力したフレームのローカルパス */
  frameFiles: Map<string, { before: string | null; after: string }>;
}

/**
 * 発話セグメントを操作セグメントに割り当てる（純関数）。
 *
 * 発話は操作に先行する傾向があるため、各操作の参照ウィンドウは
 * [transitionStart - leadMs, tEnd]。複数の操作ウィンドウに重なる発話は、
 * 操作開始時刻（transitionStart）に最も近い操作へ一意に割り当てる。
 */
export function assignTranscriptSnippets(
  segments: Array<Pick<OperationSegment, "transitionStartMs" | "tEndMs">>,
  transcript: TranscriptSegment[],
  leadMs: number,
): string[] {
  const assigned: string[][] = segments.map(() => []);

  for (const speech of transcript) {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < segments.length; i++) {
      const windowStart = segments[i].transitionStartMs - leadMs;
      const windowEnd = segments[i].tEndMs;
      const overlaps = speech.endMs >= windowStart && speech.startMs <= windowEnd;
      if (!overlaps) continue;
      const distance = Math.abs(segments[i].transitionStartMs - speech.startMs);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0) {
      assigned[bestIndex].push(speech.text.trim());
    }
  }

  return assigned.map((texts) => texts.filter(Boolean).join(" "));
}

/** 差分bbox周辺（パディング付き）に重なるOCR行を抽出する（純関数） */
export function computeOcrFocus(
  regions: Array<{ text: string; x: number; y: number; w: number; h: number }>,
  bbox: NormalizedRect | null,
  padRatio = 0.04,
): string[] {
  if (!bbox) return [];
  const padded: NormalizedRect = {
    x: bbox.x - padRatio,
    y: bbox.y - padRatio,
    w: bbox.w + padRatio * 2,
    h: bbox.h + padRatio * 2,
  };
  return regions
    .filter((region) => rectsIntersect(padded, region))
    .map((region) => region.text);
}

export async function extractEvidence(
  videoPath: string,
  options: ExtractEvidenceOptions,
): Promise<ExtractedEvidence> {
  const sampleFps = options.sampleFps ?? ENV.evidenceSampleFps;
  const diffHigh = options.diffHigh ?? ENV.evidenceDiffHigh;
  const diffLow = options.diffLow ?? ENV.evidenceDiffLow;
  const stableFrames = options.stableFrames ?? ENV.evidenceStableFrames;
  const coalesceMaxGapMs = options.coalesceMaxGapMs ?? ENV.evidenceCoalesceMaxGapMs;
  const asrLeadMs = options.asrLeadMs ?? ENV.asrLeadMs;
  const asrProvider = options.asrProvider ?? ENV.asrProvider;
  const ocrProvider = options.ocrProvider ?? ENV.ocrProvider;
  const onProgress = options.onProgress ?? (() => {});

  await fs.mkdir(options.framesDir, { recursive: true });

  const videoSha256 = await hashFile(videoPath);

  // 1. サンプリングとセグメント検出
  await onProgress(0.05, "動画をサンプリングしています...");
  const timeline = await sampleGrayTimeline(videoPath, { fps: sampleFps });
  logger.info(
    `Sampled ${timeline.frames.length} frames @${sampleFps}fps (${timeline.durationMs}ms)`,
  );

  const segments = detectSegments(timeline.frames, timeline.width, timeline.height, {
    fps: sampleFps,
    highThreshold: diffHigh,
    lowThreshold: diffLow,
    stableFrames,
    coalesceMaxGapMs,
  });
  logger.info(`Detected ${segments.length} operation segments`);
  await onProgress(0.2, `${segments.length}個の操作セグメントを検出しました`);

  // 2. ASR（音声なし動画は警告付きでスキップされる）
  const transcript: TranscriptionResult = await transcribeVideoSource(
    videoPath,
    asrProvider,
  );
  const snippets = assignTranscriptSnippets(segments, transcript.segments, asrLeadMs);
  await onProgress(0.35, "音声の文字起こしが完了しました");

  // 3. 代表フレーム抽出 + OCR
  const frameMs = 1000 / sampleFps;
  const evidenceSegments: EvidenceSegment[] = [];
  const frameFiles = new Map<string, { before: string | null; after: string }>();

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const segmentId = `seg-${i + 1}`;
    const warnings: string[] = [];

    const afterTimeMs = Math.round(segment.afterFrameIndex * frameMs);
    const afterPath = path.join(options.framesDir, `${segmentId}_after.jpg`);
    await extractFullFrame(videoPath, afterTimeMs, afterPath);

    let beforePath: string | null = null;
    let beforeTimeMs: number | null = null;
    if (segment.beforeFrameIndex !== null) {
      beforeTimeMs = Math.round(segment.beforeFrameIndex * frameMs);
      beforePath = path.join(options.framesDir, `${segmentId}_before.jpg`);
      await extractFullFrame(videoPath, beforeTimeMs, beforePath);
    }

    let ocrLines: string[] = [];
    let ocrFocus: string[] = [];
    try {
      const ocr = await extractFrameOcrUnified(afterPath, segment.afterFrameIndex, ocrProvider);
      ocrLines = ocr.lines;
      ocrFocus = computeOcrFocus(ocr.regions, segment.changedBBox);
      warnings.push(...ocr.warnings);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`OCR failed: ${message.substring(0, 120)}`);
    }

    evidenceSegments.push({
      segment_id: segmentId,
      t_start: segment.tStartMs,
      t_end: segment.tEndMs,
      transition_start: segment.transitionStartMs,
      before_frame:
        beforePath !== null && beforeTimeMs !== null
          ? { t: beforeTimeMs, image_key: beforePath, image_url: beforePath, frame_id: null }
          : null,
      after_frame: { t: afterTimeMs, image_key: afterPath, image_url: afterPath, frame_id: null },
      changed_region_bbox: segment.changedBBox,
      ocr_lines: ocrLines,
      ocr_focus: ocrFocus,
      transcript_snippet: snippets[i] ?? "",
      coalesced_from: segment.coalescedFrom,
      warnings,
    });
    frameFiles.set(segmentId, { before: beforePath, after: afterPath });

    await onProgress(
      0.35 + 0.6 * ((i + 1) / segments.length),
      `証拠を抽出中 (${i + 1}/${segments.length})`,
    );
  }

  const ocrEngineName =
    ocrProvider === "engine" ? getSharedOcrEngine().engine : null;

  const artifact: EvidenceArtifact = {
    version: EVIDENCE_ARTIFACT_VERSION,
    project_id: null,
    video: {
      duration_ms: timeline.durationMs,
      fps_sampled: sampleFps,
      sha256: videoSha256,
    },
    config: {
      diff_high: diffHigh,
      diff_low: diffLow,
      stable_frames: stableFrames,
      coalesce_max_gap_ms: coalesceMaxGapMs,
      asr_lead_ms: asrLeadMs,
      asr_provider: transcript.provider,
      ocr_provider: ocrProvider,
      ocr_engine: ocrEngineName,
    },
    transcript: {
      provider: transcript.provider,
      segments: transcript.segments,
    },
    segments: evidenceSegments,
    generated_at: new Date().toISOString(),
  };

  await onProgress(1, "証拠抽出が完了しました");
  return { artifact, frameFiles };
}
