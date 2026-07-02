/**
 * Stage B: 一括ステップ執筆（Phase 2）
 *
 * 証拠ダイジェスト全体をLLMに渡し、ステップの統合・破棄の裁量を与えて執筆させる。
 * 出力は機械検証（verification.ts）を通し、不採用セグメントは
 * フォールバックステップとして残す（失敗しても全体は完走する）。
 *
 * docs/plans/phase-2-step-authoring.md 参照。
 */

import { ENV } from "../_core/env";
import { createLogger } from "../_core/logger";
import { getCachedJson, setCachedJson } from "../_core/pipelineCache";
import type { EvidenceArtifact, EvidenceSegment } from "../evidence/types";
import type { Overview, ReviewReasonCode } from "../stepsArtifact";
import {
  buildGlobalContext,
  chunkSegments,
  DEFAULT_CHUNK_SIZE,
  type AuthoringChunk,
} from "./digest";
import { AUTHORING_PROMPT_VERSION } from "./promptVersion";
import { createAuthoringProvider } from "./providers";
import {
  parseRawAuthoringResponse,
  type RawAuthoredStep,
  type RawAuthoringResponse,
} from "./schema";
import {
  checkCrossStepIntegrity,
  checkSegmentIntegrity,
  computeCalibratedConfidence,
  needsReview,
  verifyCitedLabels,
} from "./verification";

export { AUTHORING_PROMPT_VERSION };

const logger = createLogger("Authoring");

/** 検証済みの執筆結果ステップ */
export interface AuthoredStep extends RawAuthoredStep {
  confidence: number;
  needs_review: boolean;
  review_reasons: string[];
  warnings: string[];
  /** フォールバック由来かどうか（ログ用） */
  fallback: boolean;
}

export interface AuthoringResult {
  overview: Overview;
  steps: AuthoredStep[];
  discarded: Array<{ segment_id: string; reason: string }>;
  warnings: string[];
}

type FallbackReasonCode = "chunk_authoring_failed" | "unassigned_segment";

async function invokeAuthoringProvider(
  globalContext: string,
  chunk: AuthoringChunk,
  interimOverview: Overview | null,
  cacheKeyBase: Record<string, unknown>
): Promise<RawAuthoringResponse> {
  const useCache =
    ENV.authoringProvider !== "codex_app_server" ||
    ENV.codexModel.trim().length > 0;
  const cacheKey = {
    ...cacheKeyBase,
    chunkIndex: chunk.chunkIndex,
    segmentIds: chunk.digests.map(digest => digest.segment.segment_id),
    interimOverview,
  };
  if (useCache) {
    const cached = await getCachedJson<RawAuthoringResponse>(
      "authoring",
      cacheKey
    );
    if (cached) return parseRawAuthoringResponse(cached);
  }

  const provider = createAuthoringProvider();
  const parsed = await provider.invokeChunk({
    globalContext,
    chunk,
    interimOverview,
  });

  if (useCache) {
    await setCachedJson("authoring", cacheKey, parsed);
  }
  return parsed;
}

/** セグメントからのフォールバックステップ（LLM不採用・失敗時） */
export function buildFallbackStep(
  segment: EvidenceSegment,
  index: number,
  reasonCode: FallbackReasonCode,
  reasonText: string
): AuthoredStep {
  return {
    source_segment_ids: [segment.segment_id],
    title: `ステップ ${index + 1}`,
    instruction: "画面の操作を確認する",
    expected_result: "画面が意図どおり更新される",
    operation: "操作を分析できませんでした",
    description: "このステップは手動で編集してください。",
    narration: "",
    cited_ui_labels: [],
    confidence: 0.2,
    needs_review: true,
    review_reasons: [`fallback:${reasonCode}` satisfies ReviewReasonCode],
    warnings: [`authoring fallback: ${reasonText.substring(0, 120)}`],
    fallback: true,
  };
}

function sanitizeText(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

/**
 * 証拠アーティファクト全体からステップを執筆する。
 * LLM呼び出しは ceil(セグメント数/チャンクサイズ) 回 +（複数チャンク時のみ）overview確定1回。
 */
export async function authorSteps(
  evidence: EvidenceArtifact,
  options: { chunkSize?: number } = {}
): Promise<AuthoringResult> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunks = chunkSegments(evidence, chunkSize);
  const globalContext = buildGlobalContext(evidence);
  const segmentById = new Map(
    evidence.segments.map(segment => [segment.segment_id, segment])
  );
  const segmentOrder = new Map(
    [...evidence.segments]
      .sort((a, b) => a.t_start - b.t_start)
      .map((segment, index) => [segment.segment_id, index] as const)
  );

  const cacheKeyBase = {
    authoringProvider: ENV.authoringProvider,
    provider:
      ENV.authoringProvider === "llm" ? ENV.llmProvider : "codex_app_server",
    model:
      ENV.authoringProvider === "llm"
        ? ENV.llmModel
        : ENV.codexModel || "codex-app-server-cache-disabled",
    promptVersion: AUTHORING_PROMPT_VERSION,
    videoSha256: evidence.video.sha256,
    chunkSize,
  };

  const allSteps: AuthoredStep[] = [];
  const allDiscarded: Array<{ segment_id: string; reason: string }> = [];
  const warnings: string[] = [];
  let overview: Overview | null = null;

  for (const chunk of chunks) {
    const chunkSegmentIds = new Set(
      chunk.digests.map(digest => digest.segment.segment_id)
    );
    const handled = new Set<string>();

    let response: RawAuthoringResponse | null = null;
    try {
      response = await invokeAuthoringProvider(
        globalContext,
        chunk,
        overview,
        cacheKeyBase
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("チャンク執筆に失敗。フォールバックステップを生成します", {
        chunkIndex: chunk.chunkIndex,
        message,
      });
      warnings.push(
        `chunk ${chunk.chunkIndex} authoring failed: ${message.substring(0, 160)}`
      );
    }

    if (response) {
      overview = response.overview ?? overview;

      // 破棄宣言の検証（チャンク外のIDは無視）
      for (const discarded of response.discarded_segments ?? []) {
        if (
          chunkSegmentIds.has(discarded.segment_id) &&
          !handled.has(discarded.segment_id)
        ) {
          handled.add(discarded.segment_id);
          allDiscarded.push(discarded);
        }
      }

      // ステップの検証
      const acceptedSegmentLists: string[][] = allSteps.map(
        step => step.source_segment_ids
      );
      for (const rawStep of response.steps ?? []) {
        const integrity = checkSegmentIntegrity(
          rawStep.source_segment_ids,
          segmentOrder
        );
        if (!integrity.ok) {
          warnings.push(`step "${rawStep.title}" 不採用: ${integrity.reason}`);
          continue;
        }
        // チャンク外・処理済みセグメントを参照するステップは不採用
        const outOfChunk = rawStep.source_segment_ids.some(
          id => !chunkSegmentIds.has(id) || handled.has(id)
        );
        if (outOfChunk) {
          warnings.push(
            `step "${rawStep.title}" 不採用: チャンク外/重複セグメント参照`
          );
          continue;
        }
        const cross = checkCrossStepIntegrity([
          ...acceptedSegmentLists,
          rawStep.source_segment_ids,
        ]);
        if (!cross.ok) {
          warnings.push(`step "${rawStep.title}" 不採用: ${cross.reason}`);
          continue;
        }

        const sourceSegments = rawStep.source_segment_ids
          .map(id => segmentById.get(id))
          .filter(
            (segment): segment is EvidenceSegment => segment !== undefined
          );
        if (
          sourceSegments.length > 0 &&
          sourceSegments.every(
            segment => (segment.activity ?? "action") === "waiting"
          )
        ) {
          warnings.push(
            `step "${rawStep.title}" 不採用: activity=waiting のセグメントのみを参照`
          );
          continue;
        }

        const labelCheck = verifyCitedLabels(
          rawStep.cited_ui_labels ?? [],
          sourceSegments
        );
        const hasTranscript = sourceSegments.some(
          segment => segment.transcript_snippet.trim().length > 0
        );
        const confidence = computeCalibratedConfidence({
          labelVerifiedRatio: labelCheck.verifiedRatio,
          citedLabelCount: (rawStep.cited_ui_labels ?? []).length,
          ocrConfidence: null,
          hasTranscript,
        });

        const stepWarnings: string[] = [];
        const reviewReasons: string[] = [];
        if (labelCheck.unverified.length > 0) {
          stepWarnings.push(
            `OCRで確認できないUIラベル引用: ${labelCheck.unverified.join(", ")}`
          );
          reviewReasons.push(
            "verification:unverified_ui_label" satisfies ReviewReasonCode
          );
        }
        const stepNeedsReview = needsReview(
          confidence,
          labelCheck.unverified.length
        );
        if (stepNeedsReview && confidence < 0.5) {
          reviewReasons.push(
            "verification:low_confidence" satisfies ReviewReasonCode
          );
        }

        allSteps.push({
          source_segment_ids: rawStep.source_segment_ids,
          title: sanitizeText(rawStep.title, `ステップ ${allSteps.length + 1}`),
          instruction: sanitizeText(rawStep.instruction, "操作を実行する"),
          expected_result: sanitizeText(
            rawStep.expected_result,
            "画面が更新される"
          ),
          operation: sanitizeText(
            rawStep.operation,
            rawStep.instruction ?? "操作を実行する"
          ),
          description: sanitizeText(
            rawStep.description,
            "画面の内容を確認してください。"
          ),
          narration: (rawStep.narration ?? "").trim(),
          cited_ui_labels: (rawStep.cited_ui_labels ?? [])
            .map(label => label.trim())
            .filter(Boolean),
          confidence,
          needs_review: stepNeedsReview,
          review_reasons: Array.from(new Set(reviewReasons)),
          warnings: stepWarnings,
          fallback: false,
        });
        acceptedSegmentLists.push(rawStep.source_segment_ids);
        for (const id of rawStep.source_segment_ids) {
          handled.add(id);
        }
      }
    }

    // 未割り当てセグメント → フォールバックステップ
    for (const digest of chunk.digests) {
      const segmentId = digest.segment.segment_id;
      if (!handled.has(segmentId)) {
        if ((digest.segment.activity ?? "action") === "waiting") {
          allDiscarded.push({
            segment_id: segmentId,
            reason: "activity=waiting",
          });
        } else {
          allSteps.push(
            buildFallbackStep(
              digest.segment,
              allSteps.length,
              response ? "unassigned_segment" : "chunk_authoring_failed",
              response
                ? "セグメントが割り当てられませんでした"
                : "チャンク執筆失敗"
            )
          );
        }
        handled.add(segmentId);
      }
    }
  }

  // ステップを根拠セグメントの時系列で整列
  allSteps.sort((a, b) => {
    const orderA = segmentOrder.get(a.source_segment_ids[0]) ?? 0;
    const orderB = segmentOrder.get(b.source_segment_ids[0]) ?? 0;
    return orderA - orderB;
  });

  return {
    overview: overview ?? {
      task_title: "操作手順",
      preconditions: [],
      completion_criteria: "",
    },
    steps: allSteps,
    discarded: allDiscarded,
    warnings,
  };
}
