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
 */
export async function generateStepsForProject(projectId: number): Promise<void> {
  console.log(`[StepGenerator] Starting step generation for project ${projectId}`);

  // プロジェクトのフレームを取得
  const frames = await db.getFramesByProjectId(projectId);

  if (frames.length === 0) {
    throw new Error("フレームが見つかりません");
  }

  console.log(`[StepGenerator] Analyzing ${frames.length} frames`);

  // 各フレームを分析してステップを生成
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];

    try {
      console.log(`[StepGenerator] Analyzing frame ${i + 1}/${frames.length}`);

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
        sortOrder: i,
      });

      console.log(`[StepGenerator] Step ${i + 1} created: ${stepData.title}`);
    } catch (error) {
      console.error(`[StepGenerator] Error analyzing frame ${frame.id}:`, error);
      // エラーが発生してもスキップして続行
      await db.createStep({
        frameId: frame.id,
        projectId,
        title: `ステップ ${i + 1}`,
        operation: "操作を分析できませんでした",
        description: "このステップの詳細は手動で編集してください。",
        narration: "",
        sortOrder: i,
      });
    }
  }

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
