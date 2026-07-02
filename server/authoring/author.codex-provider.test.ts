import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvidenceArtifact, EvidenceSegment } from "../evidence/types";

const originalEnv = { ...process.env };
const invokeLLMMock = vi.hoisted(() => vi.fn());
const codexInvokeMock = vi.hoisted(() => vi.fn());
const getCachedJsonMock = vi.hoisted(() => vi.fn(async () => null));
const setCachedJsonMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../_core/llm", () => ({ invokeLLM: invokeLLMMock }));
vi.mock("./providers/codexAppServer", () => ({
  createCodexAppServerAuthoringProvider: () => ({
    invokeChunk: codexInvokeMock,
  }),
}));
vi.mock("../_core/pipelineCache", () => ({
  getCachedJson: getCachedJsonMock,
  setCachedJson: setCachedJsonMock,
  hashBinary: vi.fn(() => "hash"),
  ensurePipelineCacheDir: vi.fn(async () => {}),
}));

function makeSegment(id: string): EvidenceSegment {
  return {
    segment_id: id,
    t_start: 0,
    t_end: 1_000,
    transition_start: 100,
    before_frame: null,
    after_frame: {
      t: 1_000,
      image_key: `frames/${id}.jpg`,
      image_url: `/api/storage/frames/${id}.jpg`,
      frame_id: 100,
    },
    changed_region_bbox: null,
    ocr_lines: ["保存"],
    ocr_focus: ["保存"],
    transcript_snippet: "",
    coalesced_from: 1,
    warnings: [],
  };
}

function makeEvidence(segment: EvidenceSegment): EvidenceArtifact {
  return {
    version: "1.0",
    project_id: 1,
    video: { duration_ms: 1_000, fps_sampled: 4, sha256: "sha" },
    config: {
      diff_high: 0.0004,
      diff_low: 0.00015,
      stable_frames: 2,
      coalesce_max_gap_ms: 1_000,
      asr_lead_ms: 3_000,
      asr_provider: "none",
      ocr_provider: "engine",
      ocr_engine: "tesseract",
    },
    transcript: { provider: "none", segments: [] },
    segments: [segment],
    generated_at: new Date().toISOString(),
  };
}

function validCodexResponse(segmentId: string) {
  return {
    overview: {
      task_title: "保存",
      preconditions: [],
      completion_criteria: "保存される",
    },
    steps: [
      {
        source_segment_ids: [segmentId],
        title: "保存する",
        instruction: "保存する",
        expected_result: "保存される",
        operation: "クリック",
        description: "保存ボタンを押す",
        narration: "保存します",
        cited_ui_labels: [],
      },
    ],
    discarded_segments: [],
  };
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
  invokeLLMMock.mockReset();
  codexInvokeMock.mockReset();
  getCachedJsonMock.mockClear();
  setCachedJsonMock.mockClear();
});

describe("authorSteps with codex_app_server provider", () => {
  it("routes through Codex provider, skips LLM, and disables cache when CODEX_MODEL is unset", async () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: "test",
      AUTHORING_PROVIDER: "codex_app_server",
      CODEX_MODEL: "",
    };
    vi.resetModules();
    codexInvokeMock.mockResolvedValueOnce(validCodexResponse("seg-1"));

    const { authorSteps } = await import("./author");
    const result = await authorSteps(makeEvidence(makeSegment("seg-1")));

    expect(result.steps).toHaveLength(1);
    expect(codexInvokeMock).toHaveBeenCalledTimes(1);
    expect(invokeLLMMock).not.toHaveBeenCalled();
    expect(getCachedJsonMock).not.toHaveBeenCalled();
    expect(setCachedJsonMock).not.toHaveBeenCalled();
  });

  it("uses the authoring cache for Codex runs when CODEX_MODEL is set", async () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: "test",
      AUTHORING_PROVIDER: "codex_app_server",
      CODEX_MODEL: "gpt-5.4-codex",
    };
    vi.resetModules();
    codexInvokeMock.mockResolvedValueOnce(validCodexResponse("seg-1"));

    const { authorSteps } = await import("./author");
    const result = await authorSteps(makeEvidence(makeSegment("seg-1")));

    expect(result.steps).toHaveLength(1);
    expect(codexInvokeMock).toHaveBeenCalledTimes(1);
    expect(getCachedJsonMock).toHaveBeenCalledWith(
      "authoring",
      expect.objectContaining({
        authoringProvider: "codex_app_server",
        provider: "codex_app_server",
        model: "gpt-5.4-codex",
      })
    );
    expect(setCachedJsonMock).toHaveBeenCalledWith(
      "authoring",
      expect.objectContaining({
        authoringProvider: "codex_app_server",
        model: "gpt-5.4-codex",
      }),
      expect.objectContaining({
        overview: expect.objectContaining({ task_title: "保存" }),
      })
    );
  });

  it("uses cached Codex authoring without invoking the provider", async () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: "test",
      AUTHORING_PROVIDER: "codex_app_server",
      CODEX_MODEL: "gpt-5.4-codex",
    };
    vi.resetModules();
    getCachedJsonMock.mockResolvedValueOnce(validCodexResponse("seg-1"));

    const { authorSteps } = await import("./author");
    const result = await authorSteps(makeEvidence(makeSegment("seg-1")));

    expect(result.steps).toHaveLength(1);
    expect(codexInvokeMock).not.toHaveBeenCalled();
    expect(setCachedJsonMock).not.toHaveBeenCalled();
  });

  it("rejects schema-invalid cached Codex authoring and falls back", async () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: "test",
      AUTHORING_PROVIDER: "codex_app_server",
      CODEX_MODEL: "gpt-5.4-codex",
    };
    vi.resetModules();
    getCachedJsonMock.mockResolvedValueOnce({ steps: [] });

    const { authorSteps } = await import("./author");
    const result = await authorSteps(makeEvidence(makeSegment("seg-1")));

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].fallback).toBe(true);
    expect(result.steps[0].review_reasons).toContain(
      "fallback:chunk_authoring_failed"
    );
    expect(codexInvokeMock).not.toHaveBeenCalled();
    expect(setCachedJsonMock).not.toHaveBeenCalled();
  });

  it("falls back through existing authoring verification when Codex authoring rejects", async () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: "test",
      AUTHORING_PROVIDER: "codex_app_server",
      CODEX_MODEL: "",
    };
    vi.resetModules();
    codexInvokeMock.mockRejectedValueOnce(new Error("schema mismatch"));

    const { authorSteps } = await import("./author");
    const result = await authorSteps(makeEvidence(makeSegment("seg-1")));

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].fallback).toBe(true);
    expect(result.steps[0].review_reasons).toContain(
      "fallback:chunk_authoring_failed"
    );
    expect(result.warnings.join("\n")).toContain("schema mismatch");
    expect(invokeLLMMock).not.toHaveBeenCalled();
  });
});
