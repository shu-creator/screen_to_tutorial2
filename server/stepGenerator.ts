import { invokeLLM } from "./_core/llm";
import * as db from "./db";
import type { Frame } from "../drizzle/schema";

interface StepData {
  title: string;
  operation: string;
  description: string;
  narration: string;
}

/**
 * 画像URLを分析してステップ情報を生成
 */
async function analyzeFrame(imageUrl: string, frameNumber: number): Promise<StepData> {
  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content: `あなたは画面操作を解説するチュートリアル作成の専門家です。
画面のスクリーンショットを見て、以下の情報をJSON形式で生成してください：

1. title: このステップの簡潔なタイトル（20文字以内）
2. operation: 実行されている操作の説明（50文字以内）
3. description: 操作の詳細な説明と注意点（200文字以内）
4. narration: 音声ナレーション用の自然な口語体の説明文（100文字以内）

必ずJSON形式で出力してください。`,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `フレーム番号: ${frameNumber}\n\nこの画面で行われている操作を分析してください。`,
          },
          {
            type: "image_url",
            image_url: {
              url: imageUrl,
              detail: "high",
            },
          },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "step_analysis",
        strict: true,
        schema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "ステップの簡潔なタイトル",
            },
            operation: {
              type: "string",
              description: "実行されている操作の説明",
            },
            description: {
              type: "string",
              description: "操作の詳細な説明と注意点",
            },
            narration: {
              type: "string",
              description: "音声ナレーション用の説明文",
            },
          },
          required: ["title", "operation", "description", "narration"],
          additionalProperties: false,
        },
      },
    },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("LLMからの応答が空です");
  }

  // contentが配列の場合は最初の要素を取得
  const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
  const stepData: StepData = JSON.parse(contentStr);
  return stepData;
}

/**
 * プロジェクトの全フレームを分析してステップを生成
 * パフォーマンス改善: バッチ処理による並列化（並列度を制限してレート制限を回避）
 */
export async function generateStepsForProject(projectId: number): Promise<void> {
  console.log(`[StepGenerator] Starting step generation for project ${projectId}`);

  // 進捗: AI解析開始
  await db.updateProjectProgress(projectId, 70, "AIが画像を解析しています...");

  // プロジェクトのフレームを取得
  const frames = await db.getFramesByProjectId(projectId);

  if (frames.length === 0) {
    throw new Error("フレームが見つかりません");
  }

  console.log(`[StepGenerator] Analyzing ${frames.length} frames`);

  // 並列度を制限（APIレート制限を回避）
  const BATCH_SIZE = 3;

  // フレームを分析する関数
  const analyzeAndCreateStep = async (frame: typeof frames[0], index: number) => {
    try {
      console.log(`[StepGenerator] Analyzing frame ${index + 1}/${frames.length}`);

      // AIで画像を分析
      const stepData = await analyzeFrame(frame.imageUrl, frame.frameNumber);

      // DBにステップを保存
      await db.createStep({
        frameId: frame.id,
        projectId,
        title: stepData.title,
        operation: stepData.operation,
        description: stepData.description,
        narration: stepData.narration,
        sortOrder: index,
      });

      // 進捗: AI解析（70% → 90%）
      const analysisProgress = 70 + Math.floor((index + 1) / frames.length * 20);
      await db.updateProjectProgress(projectId, analysisProgress, `ステップを生成中 (${index + 1}/${frames.length})`);

      console.log(`[StepGenerator] Step ${index + 1} created: ${stepData.title}`);
    } catch (error) {
      // セキュリティ: エラーメッセージを制限
      const errorMsg = error instanceof Error ? error.message.substring(0, 100) : "Unknown error";
      console.error(`[StepGenerator] Error analyzing frame ${frame.id}: ${errorMsg}`);
      // エラーが発生してもスキップして続行
      await db.createStep({
        frameId: frame.id,
        projectId,
        title: `ステップ ${index + 1}`,
        operation: "操作を分析できませんでした",
        description: "このステップの詳細は手動で編集してください。",
        narration: "",
        sortOrder: index,
      });
    }
  };

  // バッチ処理で並列実行
  for (let i = 0; i < frames.length; i += BATCH_SIZE) {
    const batch = frames.slice(i, i + BATCH_SIZE);
    const promises = batch.map((frame, batchIndex) =>
      analyzeAndCreateStep(frame, i + batchIndex)
    );
    await Promise.all(promises);
  }

  // 進捗: ステップ生成完了
  await db.updateProjectProgress(projectId, 90, "ステップの生成が完了しました");

  console.log(`[StepGenerator] Step generation complete for project ${projectId}`);
}

/**
 * 単一のフレームを再分析してステップを更新
 */
export async function regenerateStep(stepId: number, frameId: number): Promise<void> {
  // フレーム情報を取得
  const frames = await db.getFramesByProjectId(0); // TODO: より効率的な方法でフレームを取得
  const frame = frames.find((f) => f.id === frameId);

  if (!frame) {
    throw new Error("フレームが見つかりません");
  }

  // AIで画像を分析
  const stepData = await analyzeFrame(frame.imageUrl, frame.frameNumber);

  // ステップを更新
  await db.updateStep(stepId, {
    title: stepData.title,
    operation: stepData.operation,
    description: stepData.description,
    narration: stepData.narration,
  });
}
