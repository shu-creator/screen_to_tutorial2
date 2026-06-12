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
import { invokeLLM } from "../_core/llm";
import { createLogger } from "../_core/logger";
import { getCachedJson, setCachedJson } from "../_core/pipelineCache";
import type { EvidenceArtifact, EvidenceSegment } from "../evidence/types";
import type { Overview } from "../stepsArtifact";
import {
  buildGlobalContext,
  chunkSegments,
  DEFAULT_CHUNK_SIZE,
  type AuthoringChunk,
} from "./digest";
import {
  checkCrossStepIntegrity,
  checkSegmentIntegrity,
  computeCalibratedConfidence,
  needsReview,
  verifyCitedLabels,
} from "./verification";

const logger = createLogger("Authoring");

export const AUTHORING_PROMPT_VERSION = "authoring-v2-grounded-1";

/** LLM応答のステップ（検証前） */
interface RawAuthoredStep {
  source_segment_ids: string[];
  title: string;
  instruction: string;
  expected_result: string;
  operation: string;
  description: string;
  narration: string;
  cited_ui_labels: string[];
}

interface RawAuthoringResponse {
  overview: Overview;
  steps: RawAuthoredStep[];
  discarded_segments: Array<{ segment_id: string; reason: string }>;
}

/** 検証済みの執筆結果ステップ */
export interface AuthoredStep extends RawAuthoredStep {
  confidence: number;
  needs_review: boolean;
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

const AUTHORING_SCHEMA = {
  name: "tutorial_authoring",
  strict: true,
  schema: {
    type: "object",
    properties: {
      overview: {
        type: "object",
        properties: {
          task_title: { type: "string" },
          preconditions: { type: "array", items: { type: "string" } },
          completion_criteria: { type: "string" },
        },
        required: ["task_title", "preconditions", "completion_criteria"],
        additionalProperties: false,
      },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            source_segment_ids: { type: "array", items: { type: "string" } },
            title: { type: "string" },
            instruction: { type: "string" },
            expected_result: { type: "string" },
            operation: { type: "string" },
            description: { type: "string" },
            narration: { type: "string" },
            cited_ui_labels: { type: "array", items: { type: "string" } },
          },
          required: [
            "source_segment_ids",
            "title",
            "instruction",
            "expected_result",
            "operation",
            "description",
            "narration",
            "cited_ui_labels",
          ],
          additionalProperties: false,
        },
      },
      discarded_segments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            segment_id: { type: "string" },
            reason: { type: "string" },
          },
          required: ["segment_id", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["overview", "steps", "discarded_segments"],
    additionalProperties: false,
  },
} as const;

const SYSTEM_PROMPT = `あなたは業務画面チュートリアルの執筆者です。操作録画から抽出された「操作セグメント」の証拠（前後の画面・変化領域・OCRテキスト・発話）をもとに、手順マニュアルを執筆してください。

必ず守る制約:
- 各ステップの source_segment_ids には根拠となるセグメントIDを必ず入れる（時系列順・重複なし）
- 連続した同種の操作（例: 複数フィールドへの入力）は1ステップに統合してよい
- スクロールのみ・ロード待ち・無意味なカーソル移動のセグメントは discarded_segments に入れて破棄する
- activity=waiting のセグメント（進捗バー・スピナー・処理待ち）は steps に使わず必ず discarded_segments に割り当てる
- 1つのstepの source_segment_ids は原則1〜2個。3個以上まとめるのは同一操作の連続（タイピング等）に限る
- UIラベル（ボタン名・項目名）はOCRテキストに実在するものだけを「」で引用し、cited_ui_labels にも列挙する。OCRにないラベルは推測しない
- 1ステップは「目的1つ・操作1つ・結果1つ」。instruction は短い命令文1文、expected_result は画面変化を1文で
- narration は全ステップ通して読み上げたとき自然につながる文体にする（「まず」「次に」「最後に」等の接続）
- title は重複させない
- すべてのセグメントを steps か discarded_segments のどちらかに必ず割り当てる`;

function buildChunkUserContent(
  globalContext: string,
  chunk: AuthoringChunk,
  interimOverview: Overview | null
): Array<
  | { type: "text"; text: string }
  | {
      type: "image_url";
      image_url: { url: string; detail: "high" | "low" | "auto" };
    }
> {
  const header: string[] = [globalContext];
  if (chunk.totalChunks > 1) {
    header.push(
      `これは ${chunk.totalChunks} チャンク中 ${chunk.chunkIndex + 1} 番目のセグメント群です。`
    );
    if (interimOverview) {
      header.push(
        `ここまでの暫定overview: ${JSON.stringify(interimOverview)}。これと矛盾しないように執筆し、必要なら改善したoverviewを返してください。`
      );
    }
  }

  const content: Array<
    | { type: "text"; text: string }
    | {
        type: "image_url";
        image_url: { url: string; detail: "high" | "low" | "auto" };
      }
  > = [{ type: "text", text: header.join("\n") }];

  for (const digest of chunk.digests) {
    content.push({ type: "text", text: digest.text });
    for (const url of digest.imageUrls) {
      content.push({ type: "image_url", image_url: { url, detail: "high" } });
    }
  }

  return content;
}

async function invokeAuthoringLLM(
  globalContext: string,
  chunk: AuthoringChunk,
  interimOverview: Overview | null,
  cacheKeyBase: Record<string, unknown>
): Promise<RawAuthoringResponse> {
  const cacheKey = {
    ...cacheKeyBase,
    chunkIndex: chunk.chunkIndex,
    segmentIds: chunk.digests.map(digest => digest.segment.segment_id),
    interimOverview,
  };
  const cached = await getCachedJson<RawAuthoringResponse>(
    "authoring",
    cacheKey
  );
  if (cached) return cached;

  const response = await invokeLLM({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: buildChunkUserContent(globalContext, chunk, interimOverview),
      },
    ],
    response_format: { type: "json_schema", json_schema: AUTHORING_SCHEMA },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("LLM応答が空です");
  }
  const raw = typeof content === "string" ? content : JSON.stringify(content);
  const parsed = JSON.parse(raw) as RawAuthoringResponse;

  await setCachedJson("authoring", cacheKey, parsed);
  return parsed;
}

/** セグメントからのフォールバックステップ（LLM不採用・失敗時） */
export function buildFallbackStep(
  segment: EvidenceSegment,
  index: number,
  reason: string
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
    warnings: [`authoring fallback: ${reason.substring(0, 120)}`],
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
    provider: ENV.llmProvider,
    model: ENV.llmModel,
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
      response = await invokeAuthoringLLM(
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
        if (labelCheck.unverified.length > 0) {
          stepWarnings.push(
            `OCRで確認できないUIラベル引用: ${labelCheck.unverified.join(", ")}`
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
          needs_review: needsReview(confidence, labelCheck.unverified.length),
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
              response
                ? "LLMがセグメントを割り当てませんでした"
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
