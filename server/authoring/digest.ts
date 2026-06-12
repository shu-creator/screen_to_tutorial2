/**
 * Stage A: 証拠ダイジェスト（Phase 2）— 機械的・LLMなし
 *
 * evidence.json から執筆用のLLM入力（テキスト+画像参照）を組み立てる。
 * 長尺対応のチャンク分割もここで行う。
 */

import type { EvidenceArtifact, EvidenceSegment } from "../evidence/types";

export const DEFAULT_CHUNK_SIZE = 40;
const MAX_OCR_LINES_PER_SEGMENT = 20;
const MAX_FOCUS_LINES_PER_SEGMENT = 8;

export interface SegmentDigest {
  segment: EvidenceSegment;
  /** LLMに渡すテキスト表現 */
  text: string;
  /** LLMに渡す画像URL（after必須、beforeはbboxがある場合のみ） */
  imageUrls: string[];
}

function truncateList(lines: string[], max: number): string[] {
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), `…他${lines.length - max}行`];
}

function formatBBox(bbox: EvidenceSegment["changed_region_bbox"]): string {
  if (!bbox) return "(なし)";
  return `x=${bbox.x.toFixed(2)} y=${bbox.y.toFixed(2)} w=${bbox.w.toFixed(2)} h=${bbox.h.toFixed(2)}`;
}

export function buildSegmentDigest(segment: EvidenceSegment): SegmentDigest {
  const lines: string[] = [
    `### segment_id: ${segment.segment_id}`,
    `time: ${segment.t_start}ms 〜 ${segment.t_end}ms（操作開始 ${segment.transition_start}ms）`,
    `activity: ${segment.activity ?? "action"}`,
    `変化領域bbox: ${formatBBox(segment.changed_region_bbox)}`,
  ];

  if (
    segment.coalesced_from > 1 ||
    segment.t_end - segment.transition_start > 3000
  ) {
    lines.push(
      `連続変化: タイピング等の連続入力の可能性（変化点${segment.coalesced_from}個）`
    );
  }

  const focus = truncateList(segment.ocr_focus, MAX_FOCUS_LINES_PER_SEGMENT);
  lines.push(
    `変化領域周辺のOCR（操作対象ラベルの候補）: ${focus.length > 0 ? focus.join(" | ") : "(なし)"}`
  );

  const ocr = truncateList(segment.ocr_lines, MAX_OCR_LINES_PER_SEGMENT);
  lines.push(`画面全体のOCR: ${ocr.length > 0 ? ocr.join(" | ") : "(なし)"}`);
  lines.push(`発話: ${segment.transcript_snippet || "(なし)"}`);

  const imageUrls: string[] = [];
  if (segment.before_frame && segment.changed_region_bbox) {
    imageUrls.push(segment.before_frame.image_url);
    lines.push("画像: 1枚目=操作前(before) 2枚目=操作後(after)");
  } else {
    lines.push("画像: 操作後(after)のみ");
  }
  imageUrls.push(segment.after_frame.image_url);

  return { segment, text: lines.join("\n"), imageUrls };
}

export interface AuthoringChunk {
  /** チャンク内のセグメント（時系列順） */
  digests: SegmentDigest[];
  chunkIndex: number;
  totalChunks: number;
}

export function chunkSegments(
  artifact: EvidenceArtifact,
  chunkSize: number = DEFAULT_CHUNK_SIZE
): AuthoringChunk[] {
  const sorted = [...artifact.segments].sort((a, b) => a.t_start - b.t_start);
  const chunks: AuthoringChunk[] = [];
  const totalChunks = Math.max(1, Math.ceil(sorted.length / chunkSize));
  for (let i = 0; i < totalChunks; i++) {
    chunks.push({
      digests: sorted
        .slice(i * chunkSize, (i + 1) * chunkSize)
        .map(buildSegmentDigest),
      chunkIndex: i,
      totalChunks,
    });
  }
  return chunks;
}

/** 動画全体の文脈テキスト（チャンク共通ヘッダー） */
export function buildGlobalContext(artifact: EvidenceArtifact): string {
  const durationSec = Math.round(artifact.video.duration_ms / 1000);
  const lines = [
    `動画の長さ: ${durationSec}秒 / 操作セグメント数: ${artifact.segments.length}`,
  ];
  const fullText = artifact.transcript.segments
    .map(segment => segment.text)
    .join(" ")
    .trim();
  if (fullText.length > 0) {
    lines.push(`ナレーション全文（先頭500字）: ${fullText.substring(0, 500)}`);
  } else {
    lines.push("ナレーション: なし（無音録画）");
  }
  return lines.join("\n");
}
