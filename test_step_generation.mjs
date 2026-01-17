import { invokeLLM } from "./server/_core/llm.ts";
import { readFileSync } from "fs";

async function testStepGeneration() {
  console.log("AI解析とステップ生成のテストを開始します...\n");

  // テストフレームのパス
  const framePath = "/home/ubuntu/test_frames/frame_000000.jpg";
  
  // 画像をBase64エンコード
  const imageBuffer = readFileSync(framePath);
  const base64Image = imageBuffer.toString("base64");
  const imageUrl = `data:image/jpeg;base64,${base64Image}`;

  try {
    console.log("AI解析を実行中...");

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
              text: "この画面で何が行われていますか？",
            },
            {
              type: "image_url",
              image_url: {
                url: imageUrl,
              },
            },
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "step_info",
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

    const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
    const stepData = JSON.parse(contentStr);

    console.log("\n✅ AI解析とステップ生成が成功しました！");
    console.log("\n生成されたステップ:");
    console.log(JSON.stringify(stepData, null, 2));

    return stepData;
  } catch (error) {
    console.error("\n❌ エラーが発生しました:");
    console.error(error);
    process.exit(1);
  }
}

testStepGeneration();
