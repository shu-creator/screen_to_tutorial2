import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvidenceArtifact, EvidenceSegment } from "../evidence/types";
import { AUTHORING_PROMPT_VERSION } from "./promptVersion";

const invokeLLMMock = vi.hoisted(() => vi.fn());
vi.mock("../_core/llm", () => ({ invokeLLM: invokeLLMMock }));
// キャッシュはテスト間の干渉を避けるため無効化
vi.mock("../_core/pipelineCache", () => ({
  getCachedJson: vi.fn(async () => null),
  setCachedJson: vi.fn(async () => {}),
  hashBinary: vi.fn(() => "hash"),
  ensurePipelineCacheDir: vi.fn(async () => {}),
}));

import { authorSteps } from "./author";

function makeSegment(
  id: string,
  tStart: number,
  tEnd: number,
  overrides: Partial<EvidenceSegment> = {}
): EvidenceSegment {
  return {
    segment_id: id,
    t_start: tStart,
    t_end: tEnd,
    transition_start: tStart + 100,
    before_frame: null,
    after_frame: {
      t: tEnd,
      image_key: `frames/${id}.jpg`,
      image_url: `/api/storage/frames/${id}.jpg`,
      frame_id: Number(id.replace("seg-", "")) + 100,
    },
    changed_region_bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
    ocr_lines: ["保存", "キャンセル"],
    ocr_focus: ["保存"],
    transcript_snippet: "",
    coalesced_from: 1,
    warnings: [],
    ...overrides,
  };
}

function makeEvidence(segments: EvidenceSegment[]): EvidenceArtifact {
  return {
    version: "1.0",
    project_id: 1,
    video: { duration_ms: 30000, fps_sampled: 4, sha256: "abc" },
    config: {
      diff_high: 0.0004,
      diff_low: 0.00015,
      stable_frames: 2,
      coalesce_max_gap_ms: 1000,
      asr_lead_ms: 3000,
      asr_provider: "none",
      ocr_provider: "engine",
      ocr_engine: "tesseract",
    },
    transcript: { provider: "none", segments: [] },
    segments,
    generated_at: new Date().toISOString(),
  };
}

function llmResponse(payload: unknown) {
  return {
    choices: [{ message: { content: JSON.stringify(payload) } }],
  };
}

const validStep = (
  ids: string[],
  title: string,
  labels: string[] = ["保存"]
) => ({
  source_segment_ids: ids,
  title,
  instruction: `「${labels[0] ?? "保存"}」をクリックする`,
  expected_result: "画面が更新される",
  operation: "クリック操作",
  description: "説明",
  narration: `${title}します`,
  cited_ui_labels: labels,
});

const overview = {
  task_title: "顧客登録",
  preconditions: ["ログイン済みであること"],
  completion_criteria: "登録完了ダイアログが表示される",
};

beforeEach(() => {
  invokeLLMMock.mockReset();
});

describe("authorSteps", () => {
  it("uses the expected post-v1 authoring prompt version", () => {
    // Intentional promotion guard: update this only with a reviewed prompt bump.
    expect(AUTHORING_PROMPT_VERSION).toBe("authoring-v2-grounded-4");
  });

  it("低G2対策の操作単位・引用制約をLLM system promptに渡す", async () => {
    const evidence = makeEvidence([makeSegment("seg-1", 0, 2000)]);

    invokeLLMMock.mockResolvedValueOnce(
      llmResponse({
        overview,
        steps: [validStep(["seg-1"], "保存する")],
        discarded_segments: [],
      })
    );

    await authorSteps(evidence);

    const systemPrompt = invokeLLMMock.mock.calls[0][0].messages[0].content;
    expect(systemPrompt).toContain("生成開始");
    expect(systemPrompt).toContain("異なる目的の操作");
    expect(systemPrompt).toContain("OCR根拠が弱い場合は cited_ui_labels を空配列");
    expect(systemPrompt).toContain("単なる状態表示・完了表示・空状態メッセージ・トースト文言");
    expect(systemPrompt).toContain("ステップがありません");
    expect(systemPrompt).toContain("操作そのものが起きた区間");
    expect(systemPrompt).toContain("クリック後の「処理中」「生成中」「完了待ち」");
    expect(systemPrompt).toContain("ボタン名が見えている操作前後の区間");
    expect(systemPrompt).toContain("結果一覧・完了状態が表示された後のセグメント");
    expect(systemPrompt).toContain("待機・生成中・完了待ちセグメントと重ならない");
    expect(systemPrompt).toContain("推測で「確認する」ステップを作らない");
  });

  it("セグメント統合・破棄を受け入れ、検証済みステップを返す", async () => {
    const evidence = makeEvidence([
      makeSegment("seg-1", 0, 2000),
      makeSegment("seg-2", 2000, 4000),
      makeSegment("seg-3", 4000, 6000), // スクロール（破棄対象）
    ]);

    invokeLLMMock.mockResolvedValueOnce(
      llmResponse({
        overview,
        steps: [validStep(["seg-1", "seg-2"], "入力して保存する")],
        discarded_segments: [{ segment_id: "seg-3", reason: "スクロールのみ" }],
      })
    );

    const result = await authorSteps(evidence);

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].source_segment_ids).toEqual(["seg-1", "seg-2"]);
    expect(result.steps[0].needs_review).toBe(false);
    expect(result.discarded).toEqual([
      { segment_id: "seg-3", reason: "スクロールのみ" },
    ]);
    expect(result.overview.task_title).toBe("顧客登録");
    expect(invokeLLMMock).toHaveBeenCalledTimes(1);
  });

  it("OCRに存在しないUIラベル引用は warning + needs_review になる", async () => {
    const evidence = makeEvidence([makeSegment("seg-1", 0, 2000)]);

    invokeLLMMock.mockResolvedValueOnce(
      llmResponse({
        overview,
        steps: [validStep(["seg-1"], "操作する", ["架空のボタン"])],
        discarded_segments: [],
      })
    );

    const result = await authorSteps(evidence);
    expect(result.steps[0].needs_review).toBe(true);
    expect(result.steps[0].review_reasons).toContain("verification:unverified_ui_label");
    expect(result.steps[0].review_reasons).toContain("verification:low_confidence");
    expect(result.steps[0].warnings.join()).toContain("架空のボタン");
    expect(result.steps[0].confidence).toBeLessThan(0.5);
  });

  it("未割り当てセグメントはフォールバックステップになる", async () => {
    const evidence = makeEvidence([
      makeSegment("seg-1", 0, 2000),
      makeSegment("seg-2", 2000, 4000), // LLMが言及し忘れる
    ]);

    invokeLLMMock.mockResolvedValueOnce(
      llmResponse({
        overview,
        steps: [validStep(["seg-1"], "操作1")],
        discarded_segments: [],
      })
    );

    const result = await authorSteps(evidence);
    expect(result.steps).toHaveLength(2);
    const fallback = result.steps.find(step => step.fallback);
    expect(fallback?.source_segment_ids).toEqual(["seg-2"]);
    expect(fallback?.needs_review).toBe(true);
    expect(fallback?.review_reasons).toEqual(["fallback:unassigned_segment"]);
  });

  it("セグメントの整合違反（重複参照・未知ID・順序逆転）のステップは不採用→フォールバック", async () => {
    const evidence = makeEvidence([
      makeSegment("seg-1", 0, 2000),
      makeSegment("seg-2", 2000, 4000),
    ]);

    invokeLLMMock.mockResolvedValueOnce(
      llmResponse({
        overview,
        steps: [
          validStep(["seg-1"], "操作1"),
          validStep(["seg-1"], "操作1の重複"), // seg-1 を二重参照
          validStep(["seg-9"], "未知ID"),
          validStep(["seg-2", "seg-1"], "順序逆転"),
        ],
        discarded_segments: [],
      })
    );

    const result = await authorSteps(evidence);
    // seg-1: 操作1が採用 / seg-2: 全候補が不採用なのでフォールバック
    expect(result.steps.filter(step => !step.fallback)).toHaveLength(1);
    expect(result.steps.filter(step => step.fallback)).toHaveLength(1);
    expect(result.warnings.length).toBeGreaterThanOrEqual(3);
  });

  it("LLM呼び出し失敗時は全セグメントがフォールバックになり完走する", async () => {
    const evidence = makeEvidence([
      makeSegment("seg-1", 0, 2000),
      makeSegment("seg-2", 2000, 4000),
    ]);

    invokeLLMMock.mockRejectedValueOnce(new Error("rate limit"));

    const result = await authorSteps(evidence);
    expect(result.steps).toHaveLength(2);
    expect(result.steps.every(step => step.fallback)).toBe(true);
    expect(result.steps.every(step => step.review_reasons.includes("fallback:chunk_authoring_failed"))).toBe(true);
  });

  it("チャンク分割時は暫定overviewを引き継ぎ、チャンク数分のLLM呼び出しになる", async () => {
    const segments = Array.from({ length: 5 }, (_, i) =>
      makeSegment(`seg-${i + 1}`, i * 1000, (i + 1) * 1000)
    );
    const evidence = makeEvidence(segments);

    invokeLLMMock
      .mockResolvedValueOnce(
        llmResponse({
          overview,
          steps: [
            validStep(["seg-1"], "操作1"),
            validStep(["seg-2"], "操作2"),
            validStep(["seg-3"], "操作3"),
          ],
          discarded_segments: [],
        })
      )
      .mockResolvedValueOnce(
        llmResponse({
          overview: { ...overview, task_title: "顧客登録（改善版）" },
          steps: [validStep(["seg-4"], "操作4"), validStep(["seg-5"], "操作5")],
          discarded_segments: [],
        })
      );

    const result = await authorSteps(evidence, { chunkSize: 3 });

    expect(invokeLLMMock).toHaveBeenCalledTimes(2);
    expect(result.steps).toHaveLength(5);
    expect(result.overview.task_title).toBe("顧客登録（改善版）");

    // 2回目の呼び出しに暫定overviewが含まれること
    const secondCallMessages = invokeLLMMock.mock.calls[1][0].messages;
    const userContent = JSON.stringify(secondCallMessages);
    expect(userContent).toContain("暫定overview");
    expect(userContent).toContain("顧客登録");
  });

  it("ステップは根拠セグメントの時系列順に整列される", async () => {
    const evidence = makeEvidence([
      makeSegment("seg-1", 0, 2000),
      makeSegment("seg-2", 2000, 4000),
    ]);

    invokeLLMMock.mockResolvedValueOnce(
      llmResponse({
        overview,
        steps: [
          validStep(["seg-2"], "後の操作"),
          validStep(["seg-1"], "先の操作"),
        ],
        discarded_segments: [],
      })
    );

    const result = await authorSteps(evidence);
    expect(result.steps.map(step => step.title)).toEqual([
      "先の操作",
      "後の操作",
    ]);
  });

  it("activity=waiting のみを根拠にしたステップは不採用にして discarded にする", async () => {
    const evidence = makeEvidence([
      makeSegment("seg-1", 0, 2000, { activity: "waiting" }),
      makeSegment("seg-2", 2000, 4000),
    ]);

    invokeLLMMock.mockResolvedValueOnce(
      llmResponse({
        overview,
        steps: [
          validStep(["seg-1"], "待機を説明する"),
          validStep(["seg-2"], "操作する"),
        ],
        discarded_segments: [],
      })
    );

    const result = await authorSteps(evidence);

    expect(result.steps.map(step => step.source_segment_ids)).toEqual([
      ["seg-2"],
    ]);
    expect(result.discarded).toContainEqual({
      segment_id: "seg-1",
      reason: "activity=waiting",
    });
    expect(result.discarded.filter(d => d.segment_id === "seg-1")).toHaveLength(1);
    expect(result.warnings.join("\n")).toContain(
      'step "待機を説明する" 不採用: activity=waiting のセグメントのみを参照'
    );
  });

  it("LLMがdiscarded_segmentsにもseg-1を宣言し、かつseg-1のみ参照のwaitingステップを返すケースでdiscardedへの二重追加が起きない", async () => {
    const evidence = makeEvidence([
      makeSegment("seg-1", 0, 2000, { activity: "waiting" }),
      makeSegment("seg-2", 2000, 4000),
    ]);

    invokeLLMMock.mockResolvedValueOnce(
      llmResponse({
        overview,
        steps: [
          validStep(["seg-1"], "待機を説明する"),
          validStep(["seg-2"], "操作する"),
        ],
        // LLMが waiting の seg-1 を discarded_segments にも宣言してくる
        discarded_segments: [{ segment_id: "seg-1", reason: "LLMが直接破棄宣言" }],
      })
    );

    const result = await authorSteps(evidence);

    // 実経路: discarded_segments ループが先に handled.add("seg-1") するため（先勝ち）、
    // seg-1 を参照するステップは「チャンク外/重複セグメント参照」で不採用となり、
    // waiting 不採用パス・未割り当てループでの再追加は発生しない。
    // よって seg-1 は discarded に1件だけ存在し、reason は LLM 宣言由来になる。
    expect(result.discarded.filter(d => d.segment_id === "seg-1")).toHaveLength(1);
    expect(result.discarded.find(d => d.segment_id === "seg-1")?.reason).toBe("LLMが直接破棄宣言");
    // seg-2 は採用されているのでステップに含まれる
    expect(result.steps.some(s => s.source_segment_ids.includes("seg-2"))).toBe(true);
  });
});
