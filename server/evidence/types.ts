/**
 * evidence.json スキーマ（Phase 1）
 *
 * docs/plans/phase-1-evidence-extraction.md のスキーマ定義に対応する。
 * 証拠抽出は決定的な前処理であり、このアーティファクトが
 * ステップ執筆フェーズ（Phase 2）の入力契約になる。
 */

import { z } from "zod";

export const EVIDENCE_ARTIFACT_VERSION = "1.0";

export const normalizedRectSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});

export const evidenceFrameRefSchema = z.object({
  /** フレームの動画内時刻（ms） */
  t: z.number(),
  /** ストレージキー（CLI実行時は相対ファイルパス） */
  image_key: z.string(),
  /** 配信URL（CLI実行時はファイルパス） */
  image_url: z.string(),
  /**
   * frames テーブル保存後のID。
   * steps.json v2 の representative_frames / DB同期が要求するため、
   * プロジェクトフロー（DBあり）では必須。CLI実行時は null。
   */
  frame_id: z.number().nullable(),
});

export const transcriptSegmentSchema = z.object({
  startMs: z.number(),
  endMs: z.number(),
  text: z.string(),
  confidence: z.number(),
});

export const evidenceSegmentSchema = z.object({
  segment_id: z.string(),
  /** セグメント区間: 直前の操作の安定化時刻（先頭は0）〜 この操作の安定化時刻 */
  t_start: z.number(),
  t_end: z.number(),
  /** 操作（画面変化）の開始時刻。クリップ切り出し・境界評価の基準 */
  transition_start: z.number(),
  /** 操作直前の安定状態（先頭セグメント等で存在しない場合は null） */
  before_frame: evidenceFrameRefSchema.nullable(),
  /** 操作後の安定状態 = 代表フレーム */
  after_frame: evidenceFrameRefSchema,
  changed_region_bbox: normalizedRectSchema.nullable(),
  /** after フレーム全画面のOCR行 */
  ocr_lines: z.array(z.string()),
  /** 差分bbox周辺（パディング付き）のOCR行。操作対象ラベルの候補 */
  ocr_focus: z.array(z.string()),
  transcript_snippet: z.string(),
  /** 合体した変化点数（1 = 合体なし）。タイピング検知の手がかり */
  coalesced_from: z.number(),
  warnings: z.array(z.string()),
});

export const evidenceArtifactSchema = z.object({
  version: z.string(),
  project_id: z.number().nullable(),
  video: z.object({
    duration_ms: z.number(),
    fps_sampled: z.number(),
    sha256: z.string(),
  }),
  config: z.object({
    diff_high: z.number(),
    diff_low: z.number(),
    stable_frames: z.number(),
    coalesce_max_gap_ms: z.number(),
    asr_lead_ms: z.number(),
    asr_provider: z.string(),
    ocr_provider: z.string(),
    ocr_engine: z.string().nullable(),
  }),
  transcript: z.object({
    provider: z.string(),
    segments: z.array(transcriptSegmentSchema),
  }),
  segments: z.array(evidenceSegmentSchema),
  generated_at: z.string(),
});

export type NormalizedRect = z.infer<typeof normalizedRectSchema>;
export type EvidenceFrameRef = z.infer<typeof evidenceFrameRefSchema>;
export type EvidenceSegment = z.infer<typeof evidenceSegmentSchema>;
export type EvidenceArtifact = z.infer<typeof evidenceArtifactSchema>;

export function parseEvidenceArtifact(raw: unknown): EvidenceArtifact {
  const parsed = evidenceArtifactSchema.parse(raw);
  if (parsed.version !== EVIDENCE_ARTIFACT_VERSION) {
    throw new Error(
      `未対応の evidence.json バージョンです: ${parsed.version}（対応: ${EVIDENCE_ARTIFACT_VERSION}）`,
    );
  }
  return parsed;
}
