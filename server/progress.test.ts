import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as db from "./db";

describe("進捗管理機能のテスト", () => {
  let testProjectId: number;
  let testUserId: number;

  beforeAll(async () => {
    // テスト用のユーザーとプロジェクトを作成
    await db.upsertUser({
      openId: "test_progress_user",
      name: "Progress Test User",
      email: "progress@test.com",
    });

    const user = await db.getUserByOpenId("test_progress_user");
    if (!user) throw new Error("テストユーザーの作成に失敗しました");
    testUserId = user.id;

    // テスト用プロジェクトを作成
    testProjectId = await db.createProject({
      userId: testUserId,
      title: "進捗テストプロジェクト",
      description: "進捗管理機能のテスト用",
      videoUrl: "https://example.com/test.mp4",
      videoKey: "test/progress.mp4",
      status: "processing",
    });
  });

  it("プロジェクトの進捗を更新できる", async () => {
    // 進捗を0%に設定
    await db.updateProjectProgress(testProjectId, 0, "処理を開始しています...");

    let project = await db.getProjectById(testProjectId);
    expect(project?.processingProgress).toBe(0);
    expect(project?.processingMessage).toBe("処理を開始しています...");

    // 進捗を50%に更新
    await db.updateProjectProgress(testProjectId, 50, "フレームを抽出中 (5/10)");

    project = await db.getProjectById(testProjectId);
    expect(project?.processingProgress).toBe(50);
    expect(project?.processingMessage).toBe("フレームを抽出中 (5/10)");

    // 進捗を100%に更新
    await db.updateProjectProgress(testProjectId, 100, "処理が完了しました");

    project = await db.getProjectById(testProjectId);
    expect(project?.processingProgress).toBe(100);
    expect(project?.processingMessage).toBe("処理が完了しました");
  });

  it("進捗の範囲が正しい（0-100）", async () => {
    // 0%
    await db.updateProjectProgress(testProjectId, 0, "開始");
    let project = await db.getProjectById(testProjectId);
    expect(project?.processingProgress).toBe(0);

    // 100%
    await db.updateProjectProgress(testProjectId, 100, "完了");
    project = await db.getProjectById(testProjectId);
    expect(project?.processingProgress).toBe(100);

    // 中間値
    await db.updateProjectProgress(testProjectId, 42, "処理中");
    project = await db.getProjectById(testProjectId);
    expect(project?.processingProgress).toBe(42);
  });

  it("進捗メッセージが正しく保存される", async () => {
    const messages = [
      "動画処理を開始しています...",
      "動画からフレームを抽出しています...",
      "5個のフレームを抽出しました",
      "フレームをアップロード中 (3/5)",
      "フレームの処理が完了しました",
      "AIが画像を解析しています...",
      "ステップを生成中 (2/5)",
      "ステップの生成が完了しました",
      "処理が完了しました",
    ];

    for (let i = 0; i < messages.length; i++) {
      const progress = Math.floor((i / (messages.length - 1)) * 100);
      await db.updateProjectProgress(testProjectId, progress, messages[i]);

      const project = await db.getProjectById(testProjectId);
      expect(project?.processingMessage).toBe(messages[i]);
      expect(project?.processingProgress).toBe(progress);
    }
  });

  it("プロジェクトのステータスと進捗が独立して管理される", async () => {
    // ステータスをprocessingに設定
    await db.updateProjectStatus(testProjectId, "processing");
    await db.updateProjectProgress(testProjectId, 25, "処理中");

    let project = await db.getProjectById(testProjectId);
    expect(project?.status).toBe("processing");
    expect(project?.processingProgress).toBe(25);

    // 進捗を更新してもステータスは変わらない
    await db.updateProjectProgress(testProjectId, 75, "もうすぐ完了");
    project = await db.getProjectById(testProjectId);
    expect(project?.status).toBe("processing");
    expect(project?.processingProgress).toBe(75);

    // ステータスをcompletedに変更
    await db.updateProjectStatus(testProjectId, "completed");
    project = await db.getProjectById(testProjectId);
    expect(project?.status).toBe("completed");
    expect(project?.processingProgress).toBe(75); // 進捗は保持される
  });

  afterAll(async () => {
    // テストデータのクリーンアップは不要（各テストで独立したデータを使用）
  });
});
