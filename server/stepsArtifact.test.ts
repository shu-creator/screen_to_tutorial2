import { describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

// loadStepsArtifact のストレージを一時ディレクトリに向ける（importより先に実行）
const storageRoot = vi.hoisted(() => {
  const dir = require("path").join(
    require("os").tmpdir(),
    `steps_artifact_test_${Date.now()}`,
  );
  process.env.STORAGE_DIR = dir;
  return dir;
});

import {
  buildStepsArtifactFromDb,
  invalidateStepsArtifact,
  loadStepsArtifact,
  patchStepArtifact,
  StepsArtifactSchema,
  STEPS_ARTIFACT_VERSION,
} from "./stepsArtifact";

async function writeArtifactFile(projectId: number, content: unknown): Promise<void> {
  const filePath = path.join(storageRoot, `projects/${projectId}/artifacts/steps.json`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(content, null, 2));
}

const v1Step = {
  step_id: "step-1",
  sort_order: 0,
  frame_id: 100,
  legacy_step_db_id: 200,
  t_start: 0,
  t_end: 1500,
  representative_frames: [
    { frame_id: 100, frame_number: 0, timestamp: 0, image_url: "/api/storage/p/f.jpg" },
  ],
  changed_region_bbox: null,
  ocr_text: ["保存"],
  transcript_snippet: "",
  instruction: "保存を押す",
  expected_result: "保存される",
  warnings: [],
  confidence: 0.8,
  title: "保存する",
  operation: "保存を押す",
  description: "データを保存する",
  narration: "保存します",
  audio_url: "/api/storage/p/a.mp3",
  audio_key: "p/a.mp3",
};

const v1Artifact = {
  version: "1.0",
  project_id: 77,
  generated_at: new Date().toISOString(),
  config: {
    asr_provider: "none",
    ocr_provider: "llm",
    llm_provider: "openai",
    llm_model: "gpt-5.2",
    prompt_version: "steps-grounded-v1",
  },
  steps: [v1Step],
};

describe("steps artifact v1 -> v2 migration", () => {
  it("v1 artifact を読み込むと v2 にマイグレーションされる", async () => {
    await writeArtifactFile(77, v1Artifact);
    const loaded = await loadStepsArtifact(77);

    expect(loaded).not.toBeNull();
    expect(loaded?.version).toBe(STEPS_ARTIFACT_VERSION);
    expect(loaded?.overview).toBeNull();
    expect(loaded?.steps[0].source_segment_ids).toEqual([]);
    expect(loaded?.steps[0].cited_ui_labels).toEqual([]);
    expect(loaded?.steps[0].needs_review).toBe(false);
    expect(loaded?.steps[0].review_reasons).toEqual([]);
    expect(loaded?.steps[0].audio_mode).toBe("auto");
    // 運用必須フィールドが維持される（audio / legacy id / frame_id）
    expect(loaded?.steps[0].audio_url).toBe("/api/storage/p/a.mp3");
    expect(loaded?.steps[0].legacy_step_db_id).toBe(200);
    expect(loaded?.steps[0].frame_id).toBe(100);
  });

  it("未知バージョンはサイレントにnullへフォールバックせずエラーになる", async () => {
    await writeArtifactFile(78, { ...v1Artifact, project_id: 78, version: "9.9" });
    await expect(loadStepsArtifact(78)).rejects.toThrow("未対応");
  });

  it("既存v2 artifactに review_reasons/audio_mode が無くてもデフォルトで読める", async () => {
    await writeArtifactFile(80, {
      ...v1Artifact,
      version: STEPS_ARTIFACT_VERSION,
      project_id: 80,
      overview: null,
      steps: [{
        ...v1Step,
        source_segment_ids: ["seg-1"],
        cited_ui_labels: ["保存"],
        needs_review: true,
      }],
    });

    const loaded = await loadStepsArtifact(80);

    expect(loaded?.steps[0].review_reasons).toEqual([]);
    expect(loaded?.steps[0].audio_mode).toBe("auto");
  });

  it("invalidate されたartifactは null（artifactなし扱い）", async () => {
    await writeArtifactFile(79, { ...v1Artifact, project_id: 79 });
    await invalidateStepsArtifact(79);
    expect(await loadStepsArtifact(79)).toBeNull();
  });

  it("ファイルが無ければ null（正常系）", async () => {
    expect(await loadStepsArtifact(99999)).toBeNull();
  });

  it("patchStepArtifact はファイルが無ければ false を返す", async () => {
    await expect(patchStepArtifact(99998, (artifact) => artifact)).resolves.toBe(false);
  });

  it("patchStepArtifact はファイルがあれば保存して true を返す", async () => {
    await writeArtifactFile(81, { ...v1Artifact, project_id: 81 });

    const patched = await patchStepArtifact(81, (artifact) => ({
      ...artifact,
      steps: artifact.steps.map((step) => ({ ...step, title: "patched" })),
    }));
    const loaded = await loadStepsArtifact(81);

    expect(patched).toBe(true);
    expect(loaded?.steps[0].title).toBe("patched");
  });
});

describe("steps artifact", () => {
  it("builds valid artifact from legacy db rows", () => {
    const project = {
      id: 10,
      userId: 1,
      title: "test",
      description: null,
      videoUrl: "/api/storage/projects/10/videos/demo.mp4",
      videoKey: "projects/10/videos/demo.mp4",
      status: "completed",
      processingProgress: 100,
      processingMessage: null,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const frames = [
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
        frameNumber: 20,
        timestamp: 1500,
        imageUrl: "/api/storage/projects/10/frames/1.jpg",
        imageKey: "projects/10/frames/1.jpg",
        diffScore: 15,
        sortOrder: 1,
        createdAt: new Date(),
      },
    ];

    const steps = [
      {
        id: 200,
        frameId: 100,
        projectId: 10,
        title: "ログイン",
        operation: "ログインボタンを押す",
        description: "ホームへ遷移する",
        narration: "ログインボタンを押します",
        audioUrl: null,
        audioKey: null,
        sortOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    const artifact = buildStepsArtifactFromDb(project, frames, steps);
    const parsed = StepsArtifactSchema.parse(artifact);

    expect(parsed.project_id).toBe(10);
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.steps[0].step_id).toBe("step-1");
    expect(parsed.steps[0].instruction).toBe("ログインボタンを押す");
    expect(parsed.steps[0].expected_result).toBe("ホームへ遷移する");
  });
});
