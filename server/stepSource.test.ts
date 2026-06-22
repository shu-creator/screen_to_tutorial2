import { describe, expect, it } from "vitest";
import type { Frame } from "../drizzle/schema";
import type { StepsArtifact } from "./stepsArtifact";
import {
  buildStepListFromDbRows,
  buildStepListFromArtifact,
  deleteArtifactStepByLegacyId,
  patchArtifactStepForUpdate,
  reorderArtifactStepsByLegacyIds,
} from "./stepSource";

const frames: Frame[] = [
  {
    id: 100,
    projectId: 10,
    frameNumber: 0,
    timestamp: 0,
    imageUrl: "/api/storage/projects/10/frames/0.jpg",
    imageKey: "projects/10/frames/0.jpg",
    diffScore: 0,
    sortOrder: 0,
    createdAt: new Date(),
  },
  {
    id: 101,
    projectId: 10,
    frameNumber: 1,
    timestamp: 1500,
    imageUrl: "/api/storage/projects/10/frames/1.jpg",
    imageKey: "projects/10/frames/1.jpg",
    diffScore: 1,
    sortOrder: 1,
    createdAt: new Date(),
  },
];

function makeArtifact(): StepsArtifact {
  return {
    version: "2.0",
    project_id: 10,
    generated_at: "2026-06-21T00:00:00.000Z",
    config: {
      asr_provider: "none",
      ocr_provider: "llm",
      llm_provider: "openai",
      llm_model: "gpt-5.4",
      prompt_version: "authoring-v2-grounded-3",
    },
    overview: {
      task_title: "Demo",
      preconditions: [],
      completion_criteria: "Done",
    },
    steps: [
      {
        step_id: "step-2",
        sort_order: 1,
        frame_id: 101,
        legacy_step_db_id: 202,
        t_start: 1500,
        t_end: 3000,
        representative_frames: [
          {
            frame_id: 101,
            frame_number: 1,
            timestamp: 1500,
            image_url: "/api/storage/projects/10/frames/1.jpg",
          },
        ],
        changed_region_bbox: null,
        ocr_text: [],
        transcript_snippet: "",
        instruction: "保存する",
        expected_result: "保存される",
        warnings: ["verify"],
        confidence: 0.6,
        title: "保存",
        operation: "保存ボタンを押す",
        description: "保存完了を確認する",
        narration: "保存します",
        audio_mode: "auto",
        audio_url: "/api/storage/projects/10/audio/2.mp3",
        audio_key: "projects/10/audio/2.mp3",
        source_segment_ids: ["seg-2"],
        cited_ui_labels: ["保存"],
        needs_review: true,
        review_reasons: ["verification:low_confidence"],
      },
      {
        step_id: "step-1",
        sort_order: 0,
        frame_id: 100,
        legacy_step_db_id: 201,
        t_start: 0,
        t_end: 1500,
        representative_frames: [
          {
            frame_id: 100,
            frame_number: 0,
            timestamp: 0,
            image_url: "/api/storage/projects/10/frames/0.jpg",
          },
        ],
        changed_region_bbox: null,
        ocr_text: [],
        transcript_snippet: "",
        instruction: "開く",
        expected_result: "画面が開く",
        warnings: [],
        confidence: 0.9,
        title: "開く",
        operation: "画面を開く",
        description: "対象画面を表示する",
        narration: "開きます",
        audio_mode: "auto",
        source_segment_ids: ["seg-1"],
        cited_ui_labels: ["開く"],
        needs_review: false,
        review_reasons: [],
      },
    ],
  };
}

describe("step source artifact helpers", () => {
  it("normalizes DB rows to UI-compatible step rows", () => {
    const rows = buildStepListFromDbRows([
      {
        id: 301,
        projectId: 10,
        frameId: 100,
        title: "DB",
        operation: "DB op",
        description: "DB desc",
        narration: null,
        audioUrl: null,
        audioKey: null,
        sortOrder: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 300,
        projectId: 10,
        frameId: 101,
        title: "First",
        operation: "First op",
        description: "First desc",
        narration: "Narration",
        audioUrl: "/audio.mp3",
        audioKey: "audio.mp3",
        sortOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    expect(rows.map((row) => row.id)).toEqual([300, 301]);
    expect(rows[1]).toMatchObject({
      narration: "",
      audioUrl: null,
      audioKey: null,
    });
  });

  it("builds UI-compatible step rows from artifact order", () => {
    const rows = buildStepListFromArtifact(10, makeArtifact(), frames);

    expect(rows.map((row) => row.id)).toEqual([201, 202]);
    expect(rows[0]).toMatchObject({
      projectId: 10,
      frameId: 100,
      sortOrder: 0,
      title: "開く",
      audioUrl: null,
    });
    expect(rows[1]).toMatchObject({
      frameId: 101,
      audioUrl: "/api/storage/projects/10/audio/2.mp3",
      audioKey: "projects/10/audio/2.mp3",
    });
  });

  it("patches artifact fields used by UI edit", () => {
    const result = patchArtifactStepForUpdate(makeArtifact(), 202, {
      title: "保存済み",
      operation: "保存して閉じる",
      description: "保存後に閉じる",
      narration: "保存して閉じます",
      tStart: 1600,
      tEnd: 3100,
      audioMode: "silent",
      markReviewed: true,
    });

    expect(result.matched).toBe(true);
    const patched = result.artifact.steps.find((step) => step.legacy_step_db_id === 202);
    expect(patched).toMatchObject({
      title: "保存済み",
      operation: "保存して閉じる",
      instruction: "保存して閉じる",
      description: "保存後に閉じる",
      expected_result: "保存後に閉じる",
      narration: "保存して閉じます",
      t_start: 1600,
      t_end: 3100,
      audio_mode: "silent",
      needs_review: false,
      review_reasons: [],
      warnings: [],
    });
  });

  it("rejects patching by sort_order when legacy db id is absent", () => {
    const artifact = makeArtifact();
    const withoutLegacyId = {
      ...artifact,
      steps: artifact.steps.map((step) => (
        step.legacy_step_db_id === 202
          ? { ...step, legacy_step_db_id: undefined }
          : step
      )),
    };

    const result = patchArtifactStepForUpdate(withoutLegacyId, 999, {
      title: "must not write by sort order",
    });

    expect(result.matched).toBe(false);
    expect(result.artifact.steps.find((step) => step.sort_order === 1)?.title).not.toBe("must not write by sort order");
  });

  it("rejects invalid timing edits before saving", () => {
    expect(() => patchArtifactStepForUpdate(makeArtifact(), 202, {
      tStart: 4000,
      tEnd: 3000,
    })).toThrow("t_end");
  });

  it("deletes by legacy id and reindexes artifact order", () => {
    const result = deleteArtifactStepByLegacyId(makeArtifact(), 201);

    expect(result.matched).toBe(true);
    expect(result.artifact.steps).toHaveLength(1);
    expect(result.artifact.steps[0]).toMatchObject({
      legacy_step_db_id: 202,
      step_id: "step-1",
      sort_order: 0,
    });
  });

  it("reorders by legacy ids and rejects incomplete mappings", () => {
    const reordered = reorderArtifactStepsByLegacyIds(makeArtifact(), [202, 201]);

    expect(reordered.matched).toBe(true);
    expect(reordered.artifact.steps.map((step) => step.legacy_step_db_id)).toEqual([202, 201]);
    expect(reordered.artifact.steps.map((step) => step.sort_order)).toEqual([0, 1]);
    expect(reordered.artifact.steps.map((step) => step.step_id)).toEqual(["step-1", "step-2"]);

    const rejected = reorderArtifactStepsByLegacyIds(makeArtifact(), [202]);
    expect(rejected.matched).toBe(false);

    const overSpecified = reorderArtifactStepsByLegacyIds(makeArtifact(), [202, 201, 999]);
    expect(overSpecified.matched).toBe(false);

    const duplicate = reorderArtifactStepsByLegacyIds(makeArtifact(), [202, 202]);
    expect(duplicate.matched).toBe(false);
  });
});
