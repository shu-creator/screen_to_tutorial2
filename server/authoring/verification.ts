/**
 * ステップ執筆の機械検証（Phase 2）— すべて決定的な純関数
 *
 * 1. UIラベル照合: cited_ui_labels が根拠セグメントのOCR実測に存在するか
 * 2. 根拠整合: source_segment_ids の存在・重複・順序を検証
 * 3. 較正済みconfidence: LLM自己申告は使わず決定的な式で算出
 *
 * docs/plans/phase-2-step-authoring.md 参照。
 */

import type { EvidenceSegment } from "../evidence/types";

/** ラベル照合用の正規化（NFKC・空白除去・小文字化）。eval/metrics.ts と同一規則 */
export function normalizeLabel(label: string): string {
  return label.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

export interface LabelVerification {
  verified: string[];
  unverified: string[];
  /** 引用なし=1.0 / 全照合=1.0 / 一部不一致 < 1.0 */
  verifiedRatio: number;
}

/**
 * cited_ui_labels を根拠セグメントの OCR実測（ocr_lines ∪ ocr_focus）と照合する。
 * OCR行の部分文字列一致も許容する（OCRは周辺文字を巻き込むことがあるため）。
 */
export function verifyCitedLabels(
  citedLabels: string[],
  sourceSegments: Array<Pick<EvidenceSegment, "ocr_lines" | "ocr_focus">>,
): LabelVerification {
  const haystack = sourceSegments
    .flatMap((segment) => [...segment.ocr_lines, ...segment.ocr_focus])
    .map(normalizeLabel)
    .filter((line) => line.length > 0);

  const verified: string[] = [];
  const unverified: string[] = [];

  for (const label of citedLabels) {
    const normalized = normalizeLabel(label);
    if (normalized.length === 0) continue;
    const found = haystack.some(
      (line) => line === normalized || line.includes(normalized),
    );
    (found ? verified : unverified).push(label);
  }

  const total = verified.length + unverified.length;
  return {
    verified,
    unverified,
    verifiedRatio: total === 0 ? 1 : verified.length / total,
  };
}

export interface SegmentIntegrityResult {
  ok: boolean;
  reason?: string;
}

/**
 * source_segment_ids の整合検証:
 * - 空でない
 * - すべて実在するセグメントID
 * - 重複なし（ステップ間の重複は checkCrossStepIntegrity で検証）
 * - evidence上の時系列順に並んでいる
 */
export function checkSegmentIntegrity(
  sourceSegmentIds: string[],
  segmentOrder: Map<string, number>,
): SegmentIntegrityResult {
  if (sourceSegmentIds.length === 0) {
    return { ok: false, reason: "source_segment_ids が空" };
  }

  const seen = new Set<string>();
  let prevOrder = -1;
  for (const segmentId of sourceSegmentIds) {
    const order = segmentOrder.get(segmentId);
    if (order === undefined) {
      return { ok: false, reason: `未知のセグメントID: ${segmentId}` };
    }
    if (seen.has(segmentId)) {
      return { ok: false, reason: `セグメントIDの重複: ${segmentId}` };
    }
    seen.add(segmentId);
    if (order < prevOrder) {
      return { ok: false, reason: `セグメントの順序逆転: ${segmentId}` };
    }
    prevOrder = order;
  }

  return { ok: true };
}

/** 複数ステップ間で同じセグメントが二重に使われていないか検証する */
export function checkCrossStepIntegrity(
  stepsSegmentIds: string[][],
): SegmentIntegrityResult {
  const used = new Set<string>();
  for (const ids of stepsSegmentIds) {
    for (const id of ids) {
      if (used.has(id)) {
        return { ok: false, reason: `セグメントが複数ステップで使用: ${id}` };
      }
      used.add(id);
    }
  }
  return { ok: true };
}

export interface ConfidenceInput {
  labelVerifiedRatio: number;
  citedLabelCount: number;
  /** 根拠セグメントのOCR confidence の平均（不明なら null） */
  ocrConfidence: number | null;
  hasTranscript: boolean;
}

export const NEEDS_REVIEW_THRESHOLD = 0.5;

/**
 * 較正済みconfidence（決定的）:
 *   labelScore  = 引用なし: 0.6（根拠が薄い） / 引用あり: 検証通過率
 *   ocrScore    = 0.5 + 0.5 * ocr_confidence（OCR不明時は0.75）
 *   transcript  = 発話根拠あり: 1.0 / なし: 0.85
 *   confidence  = labelScore × ocrScore × transcript
 *
 * 実測G2との相関確認（較正）は実データ取得後に行い、係数を調整する。
 */
export function computeCalibratedConfidence(input: ConfidenceInput): number {
  const labelScore = input.citedLabelCount === 0 ? 0.6 : input.labelVerifiedRatio;
  const ocrScore = 0.5 + 0.5 * (input.ocrConfidence ?? 0.5);
  const transcriptFactor = input.hasTranscript ? 1.0 : 0.85;
  const confidence = labelScore * ocrScore * transcriptFactor;
  return Math.min(1, Math.max(0, confidence));
}

export function needsReview(confidence: number, unverifiedLabelCount: number): boolean {
  return confidence < NEEDS_REVIEW_THRESHOLD || unverifiedLabelCount > 0;
}
