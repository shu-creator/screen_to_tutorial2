/**
 * 評価メトリクス（Phase 0）
 *
 * docs/plans/phase-0-eval-harness.md の G1/G2/G3 定義の実装。
 * すべて決定的な純関数。LLM・ファイルI/Oに依存しない。
 */

export interface GroundTruthStep {
  t_start: number; // ms
  t_end: number; // ms
  title: string;
  ui_labels?: string[];
  non_step?: boolean;
}

export interface GeneratedStepLike {
  t_start: number; // ms
  t_end: number; // ms
  title: string;
  operation?: string;
  instruction?: string;
  cited_ui_labels?: string[];
}

export interface G1Result {
  precision: number;
  recall: number;
  f1: number;
  matchedPairs: Array<{ generatedIndex: number; groundTruthIndex: number; iou: number }>;
}

export interface G2Result {
  /** 引用ラベルのうち正解集合に含まれた率（引用0件のステップは分母から除外） */
  accuracy: number;
  /** 引用が1件以上あったステップ数 */
  citedStepCount: number;
  /** 引用が0件だったステップの率（G2の退化検知用。必ず併記する） */
  noCitationRate: number;
  totalLabels: number;
  matchedLabels: number;
}

export interface G3Result {
  /** 非ステップ区間にマッチした生成ステップの率 */
  rate: number;
  nonStepMatchedCount: number;
  generatedCount: number;
}

export interface BoundaryRecallResult {
  /** 正解境界のうち、許容誤差内にセグメント境界が存在した率 */
  recall: number;
  matchedBoundaries: number;
  totalBoundaries: number;
}

/** 区間IoU（Intersection over Union）。区間が無効（start >= end）の場合は0 */
export function intervalIoU(
  a: { t_start: number; t_end: number },
  b: { t_start: number; t_end: number },
): number {
  if (a.t_end <= a.t_start || b.t_end <= b.t_start) return 0;
  const intersection = Math.min(a.t_end, b.t_end) - Math.max(a.t_start, b.t_start);
  if (intersection <= 0) return 0;
  const union = Math.max(a.t_end, b.t_end) - Math.min(a.t_start, b.t_start);
  return intersection / union;
}

/**
 * G1: ステップ分割の一致率
 *
 * 生成ステップと正解ステップ（non_step を除く）をIoU降順の貪欲法で1対1マッチングし、
 * IoU >= threshold のペアを一致とみなして Precision / Recall / F1 を計算する。
 */
export function computeG1(
  generated: GeneratedStepLike[],
  groundTruth: GroundTruthStep[],
  iouThreshold = 0.5,
): G1Result {
  const gtPositive = groundTruth
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => !step.non_step);

  const candidates: Array<{ generatedIndex: number; groundTruthIndex: number; iou: number }> = [];
  for (let g = 0; g < generated.length; g++) {
    for (const { step, index } of gtPositive) {
      const iou = intervalIoU(generated[g], step);
      if (iou >= iouThreshold) {
        candidates.push({ generatedIndex: g, groundTruthIndex: index, iou });
      }
    }
  }

  candidates.sort((a, b) => b.iou - a.iou);

  const usedGenerated = new Set<number>();
  const usedGroundTruth = new Set<number>();
  const matchedPairs: G1Result["matchedPairs"] = [];

  for (const candidate of candidates) {
    if (usedGenerated.has(candidate.generatedIndex)) continue;
    if (usedGroundTruth.has(candidate.groundTruthIndex)) continue;
    usedGenerated.add(candidate.generatedIndex);
    usedGroundTruth.add(candidate.groundTruthIndex);
    matchedPairs.push(candidate);
  }

  const precision = generated.length === 0 ? 0 : matchedPairs.length / generated.length;
  const recall = gtPositive.length === 0 ? 0 : matchedPairs.length / gtPositive.length;
  const f1 =
    precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return { precision, recall, f1, matchedPairs };
}

/** 「」『』で囲まれた文字列をUIラベル引用として抽出する */
export function extractQuotedLabels(text: string): string[] {
  const labels: string[] = [];
  const pattern = /「([^「」]+)」|『([^『』]+)』/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const label = (match[1] ?? match[2] ?? "").trim();
    if (label.length > 0) {
      labels.push(label);
    }
  }
  return labels;
}

const normalizedLabelAliases: Record<string, string> = {
  アップロードするファイルを選択: "ファイルを選択",
};

/** ラベル照合用の正規化（NFKC・空白除去・小文字化） */
function normalizeLabelBase(label: string): string {
  return label
    .normalize("NFKC")
    .trim()
    .replace(/^[「『"'“”‘’]+|[」』"'“”‘’]+$/g, "")
    .replace(/\s*\(\d+\)\s*$/g, "")
    .replace(/^(ステップ)\s*\d+$/i, "$1")
    .replace(/\s+/g, "")
    .toLowerCase();
}

export function normalizeLabel(label: string): string {
  const normalized = normalizeLabelBase(label);
  const alias = normalizedLabelAliases[normalized];

  return alias === undefined ? normalized : normalizeLabelBase(alias);
}

/**
 * G2: UIラベル正確性
 *
 * 各生成ステップの title / operation / instruction から「」『』引用ラベルを抽出し、
 * structured artifact の cited_ui_labels も含めて、許容集合（正解 ui_labels ∪ OCR実測行）に
 * 正規化一致で含まれる率を計算する。
 *
 * 分母0の規約: 引用が0件のステップは分母から除外し、noCitationRate を必ず併記する
 * （引用ゼロで見かけ100%になる退化の検知用）。
 */
export function computeG2(
  generated: GeneratedStepLike[],
  allowedLabels: string[],
): G2Result {
  const allowedSet = new Set(
    allowedLabels.map(normalizeLabel).filter((label) => label.length > 0),
  );

  let totalLabels = 0;
  let matchedLabels = 0;
  let citedStepCount = 0;

  for (const step of generated) {
    const texts = [step.title, step.operation ?? "", step.instruction ?? ""];
    const labels = [
      ...texts.flatMap((text) => extractQuotedLabels(text)),
      ...(step.cited_ui_labels ?? []),
    ];
    if (labels.length === 0) continue;
    let validLabelCount = 0;
    for (const label of labels) {
      const normalized = normalizeLabel(label);
      if (normalized.length === 0) continue;
      validLabelCount += 1;
      totalLabels += 1;
      if (allowedSet.has(normalized)) {
        matchedLabels += 1;
      }
    }
    if (validLabelCount > 0) citedStepCount += 1;
  }

  return {
    accuracy: totalLabels === 0 ? 0 : matchedLabels / totalLabels,
    citedStepCount,
    noCitationRate:
      generated.length === 0 ? 0 : (generated.length - citedStepCount) / generated.length,
    totalLabels,
    matchedLabels,
  };
}

/**
 * G3: 非ステップ混入率
 *
 * 正解で non_step: true の区間にIoU >= threshold でマッチした生成ステップ数 / 生成ステップ総数。
 */
export function computeG3(
  generated: GeneratedStepLike[],
  groundTruth: GroundTruthStep[],
  iouThreshold = 0.5,
): G3Result {
  const nonStepIntervals = groundTruth.filter((step) => step.non_step);

  let nonStepMatchedCount = 0;
  for (const step of generated) {
    const matched = nonStepIntervals.some(
      (interval) => intervalIoU(step, interval) >= iouThreshold,
    );
    if (matched) nonStepMatchedCount += 1;
  }

  return {
    rate: generated.length === 0 ? 0 : nonStepMatchedCount / generated.length,
    nonStepMatchedCount,
    generatedCount: generated.length,
  };
}

/**
 * セグメント境界Recall（Phase 1 用）
 *
 * 正解ステップ境界（各ステップの t_start / t_end のユニーク集合）のうち、
 * 許容誤差 toleranceMs 内にセグメント境界が存在した率。
 * Phase 2 がセグメントを意図的に統合する設計のため、Phase 1 の
 * セグメンテーション単体は F1 ではなくこの Recall 側指標で判定する
 * （docs/plans/phase-1-evidence-extraction.md 参照）。
 */
export function computeBoundaryRecall(
  segmentBoundaries: number[],
  groundTruth: GroundTruthStep[],
  toleranceMs = 500,
): BoundaryRecallResult {
  const gtBoundaries = Array.from(
    new Set(
      groundTruth
        .filter((step) => !step.non_step)
        .flatMap((step) => [step.t_start, step.t_end]),
    ),
  );

  let matchedBoundaries = 0;
  for (const boundary of gtBoundaries) {
    const matched = segmentBoundaries.some(
      (segment) => Math.abs(segment - boundary) <= toleranceMs,
    );
    if (matched) matchedBoundaries += 1;
  }

  return {
    recall: gtBoundaries.length === 0 ? 0 : matchedBoundaries / gtBoundaries.length,
    matchedBoundaries,
    totalBoundaries: gtBoundaries.length,
  };
}
