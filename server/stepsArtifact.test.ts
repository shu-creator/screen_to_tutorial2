import { describe, expect, it } from "vitest";
import { buildStepsArtifactFromDb, StepsArtifactSchema } from "./stepsArtifact";

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
