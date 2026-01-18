import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import * as db from "./db";

describe("step.reorder", () => {
  let testProjectId: number;
  let testFrameIds: number[];
  let testStepIds: number[];
  let testUserId: number;
  let skipTests = false;

  beforeAll(async () => {
    // データベースが利用可能か確認
    const testUser = await db.getUserByOpenId("test-reorder-user");
    if (!testUser && !process.env.DATABASE_URL) {
      skipTests = true;
    }
  });

  beforeEach(async () => {
    if (skipTests) return;

    // テスト用ユーザーを作成または取得
    await db.upsertUser({
      openId: "test-reorder-user",
      name: "Reorder Test User",
    });
    const existingUser = await db.getUserByOpenId("test-reorder-user");
    if (!existingUser) {
      skipTests = true;
      return;
    }
    testUserId = existingUser.id;

    // テスト用プロジェクトを作成
    testProjectId = await db.createProject({
      userId: testUserId,
      title: "並び替えテストプロジェクト",
      status: "completed",
    });

    // テスト用フレームを作成
    testFrameIds = [];
    for (let i = 0; i < 3; i++) {
      const frameId = await db.createFrame({
        projectId: testProjectId,
        frameNumber: i,
        timestamp: i * 1000,
        imageUrl: `https://example.com/frame${i}.jpg`,
        imageKey: `frame${i}.jpg`,
      });
      testFrameIds.push(frameId);
    }

    // テスト用ステップを作成
    testStepIds = [];
    for (let i = 0; i < 3; i++) {
      const stepId = await db.createStep({
        projectId: testProjectId,
        frameId: testFrameIds[i],
        title: `ステップ ${i + 1}`,
        operation: `操作 ${i + 1}`,
        description: `説明 ${i + 1}`,
        sortOrder: i,
      });
      testStepIds.push(stepId);
    }
  });

  afterEach(async () => {
    if (skipTests) return;
    // テストデータをクリーンアップ
    if (testProjectId) {
      await db.deleteProject(testProjectId, testUserId);
    }
  });

  it("ステップの順序を入れ替えられる", async () => {
    if (skipTests) return;

    // 元の順序: [0, 1, 2]
    // 新しい順序: [2, 0, 1]
    const newOrder = [testStepIds[2], testStepIds[0], testStepIds[1]];
    await db.reorderSteps(testProjectId, newOrder);

    const steps = await db.getStepsByProjectId(testProjectId);

    expect(steps[0].id).toBe(testStepIds[2]);
    expect(steps[0].sortOrder).toBe(0);
    expect(steps[1].id).toBe(testStepIds[0]);
    expect(steps[1].sortOrder).toBe(1);
    expect(steps[2].id).toBe(testStepIds[1]);
    expect(steps[2].sortOrder).toBe(2);
  });

  it("順序を逆転できる", async () => {
    if (skipTests) return;

    // 元の順序: [0, 1, 2]
    // 新しい順序: [2, 1, 0]
    const newOrder = [testStepIds[2], testStepIds[1], testStepIds[0]];
    await db.reorderSteps(testProjectId, newOrder);

    const steps = await db.getStepsByProjectId(testProjectId);

    expect(steps[0].id).toBe(testStepIds[2]);
    expect(steps[1].id).toBe(testStepIds[1]);
    expect(steps[2].id).toBe(testStepIds[0]);
  });

  it("同じ順序で再設定しても問題ない", async () => {
    if (skipTests) return;

    // 同じ順序で再設定
    const newOrder = [testStepIds[0], testStepIds[1], testStepIds[2]];
    await db.reorderSteps(testProjectId, newOrder);

    const steps = await db.getStepsByProjectId(testProjectId);

    expect(steps[0].id).toBe(testStepIds[0]);
    expect(steps[1].id).toBe(testStepIds[1]);
    expect(steps[2].id).toBe(testStepIds[2]);
  });
});
