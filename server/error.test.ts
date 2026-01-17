import { describe, it, expect, beforeAll } from "vitest";
import * as db from "./db";

describe("エラー通知機能のテスト", () => {
  let testProjectId: number;
  let testUserId: number;

  beforeAll(async () => {
    // テスト用のユーザーとプロジェクトを作成
    await db.upsertUser({
      openId: "test_error_user",
      name: "Error Test User",
      email: "error@test.com",
    });

    const user = await db.getUserByOpenId("test_error_user");
    if (!user) throw new Error("テストユーザーの作成に失敗しました");
    testUserId = user.id;

    // テスト用プロジェクトを作成
    testProjectId = await db.createProject({
      userId: testUserId,
      title: "エラーテストプロジェクト",
      description: "エラー通知機能のテスト用",
      videoUrl: "https://example.com/test.mp4",
      videoKey: "test/error.mp4",
      status: "processing",
    });
  });

  it("エラーメッセージを保存できる", async () => {
    const errorMessage = "動画ファイルが破損しているか、対応していない形式です。";
    
    await db.updateProjectError(testProjectId, errorMessage);

    const project = await db.getProjectById(testProjectId);
    expect(project?.status).toBe("failed");
    expect(project?.errorMessage).toBe(errorMessage);
  });

  it("エラーメッセージを更新できる", async () => {
    // 最初のエラーメッセージ
    await db.updateProjectError(testProjectId, "エラー1");
    let project = await db.getProjectById(testProjectId);
    expect(project?.errorMessage).toBe("エラー1");

    // エラーメッセージを更新
    await db.updateProjectError(testProjectId, "エラー2");
    project = await db.getProjectById(testProjectId);
    expect(project?.errorMessage).toBe("エラー2");
  });

  it("長いエラーメッセージも保存できる", async () => {
    const longErrorMessage = "動画処理中にエラーが発生しました: ".repeat(50);
    
    await db.updateProjectError(testProjectId, longErrorMessage);

    const project = await db.getProjectById(testProjectId);
    expect(project?.errorMessage).toBe(longErrorMessage);
  });

  it("エラー保存時にステータスがfailedになる", async () => {
    // ステータスをprocessingに戻す
    await db.updateProjectStatus(testProjectId, "processing");
    let project = await db.getProjectById(testProjectId);
    expect(project?.status).toBe("processing");

    // エラーを保存
    await db.updateProjectError(testProjectId, "テストエラー");
    project = await db.getProjectById(testProjectId);
    expect(project?.status).toBe("failed");
    expect(project?.errorMessage).toBe("テストエラー");
  });

  it("エラーメッセージと進捗メッセージは独立している", async () => {
    // 進捗を設定
    await db.updateProjectProgress(testProjectId, 50, "処理中...");
    let project = await db.getProjectById(testProjectId);
    expect(project?.processingProgress).toBe(50);
    expect(project?.processingMessage).toBe("処理中...");

    // エラーを保存
    await db.updateProjectError(testProjectId, "エラーが発生しました");
    project = await db.getProjectById(testProjectId);
    expect(project?.status).toBe("failed");
    expect(project?.errorMessage).toBe("エラーが発生しました");
    // 進捗情報は保持される
    expect(project?.processingProgress).toBe(50);
    expect(project?.processingMessage).toBe("処理中...");
  });

  it("日本語のエラーメッセージを正しく保存できる", async () => {
    const japaneseErrors = [
      "動画ファイルが見つかりません。",
      "AI APIのレート制限に達しました。",
      "ネットワークエラーが発生しました。",
      "フレーム抽出スクリプトの実行に失敗しました。",
      "処理がタイムアウトしました。",
    ];

    for (const errorMsg of japaneseErrors) {
      await db.updateProjectError(testProjectId, errorMsg);
      const project = await db.getProjectById(testProjectId);
      expect(project?.errorMessage).toBe(errorMsg);
    }
  });
});
