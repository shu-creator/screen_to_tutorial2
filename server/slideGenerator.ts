import { promises as fs } from "fs";
import path from "path";
import { getProjectById, getStepsByProjectId, getFramesByProjectId } from "./db";

// スライドのテキスト制限
const MAX_OPERATION_CHARS = 60;  // 操作: 1行に収まる文字数
const MAX_DETAIL_CHARS = 120;    // 詳細: 約5行分（18文字/行 × 約7行の安全マージン）

// カラー定義（プロフェッショナルなパレット）
const COLORS = {
  primary: "2563EB",      // Blue-600
  primaryDark: "1D4ED8",  // Blue-700
  text: "1F2937",         // Gray-800
  textMuted: "6B7280",    // Gray-500
  accent: "3B82F6",       // Blue-500
  white: "FFFFFF",
  lightBg: "F3F4F6",      // Gray-100
};

/**
 * テキストを指定文字数で切り詰め、省略記号を追加
 */
function truncateText(text: string, maxLength: number): string {
  if (!text) return "";
  // 絵文字を除去
  const cleanText = removeEmojis(text);
  if (cleanText.length <= maxLength) return cleanText;
  return cleanText.substring(0, maxLength - 1) + "…";
}

/**
 * 絵文字を除去
 */
function removeEmojis(text: string): string {
  // 一般的な絵文字パターンを除去（ES5互換）
  return text
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "") // サロゲートペア（絵文字）
    .replace(/[\u2600-\u27BF]/g, "") // その他の記号
    .replace(/[\u2300-\u23FF]/g, "") // その他の技術記号
    .replace(/[\u2B50-\u2B55]/g, "") // 星など
    .trim();
}

/**
 * 「状態説明」文を「指示」文に変換
 * 例: 「画面が表示されています」→「画面を確認する」
 */
function convertToInstructionStyle(text: string): string {
  if (!text) return "";

  let result = text;

  // 状態説明パターンを指示形式に変換
  const patterns: [RegExp, string][] = [
    [/が表示されています[。]?$/g, "を確認する"],
    [/されています[。]?$/g, "する"],
    [/になっています[。]?$/g, "になっていることを確認"],
    [/状態です[。]?$/g, ""],
    [/ことができます[。]?$/g, ""],
    [/しましょう[。]?$/g, "する"],
    [/してください[。]?$/g, "する"],
  ];

  for (const [pattern, replacement] of patterns) {
    result = result.replace(pattern, replacement);
  }

  return result;
}

/**
 * ノート用の完全なテキストを生成
 */
function buildNotesText(step: {
  title: string;
  operation: string;
  description: string;
  narration?: string | null;
}): string {
  const parts: string[] = [];

  parts.push(`【${step.title}】`);
  parts.push("");
  parts.push(`操作: ${step.operation}`);
  parts.push("");
  parts.push(`詳細:`);
  parts.push(step.description);

  if (step.narration) {
    parts.push("");
    parts.push(`ナレーション:`);
    parts.push(step.narration);
  }

  return parts.join("\n");
}

/**
 * 一時ファイルのパスを生成
 */
function createTempFilePath(prefix: string, extension: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return path.join("/tmp", `${prefix}_${timestamp}_${random}${extension}`);
}

/**
 * スライドを生成してS3にアップロードし、URLを返す
 */
export async function generateSlides(projectId: number): Promise<string> {
  console.log(`[SlideGenerator] Starting slide generation for project ${projectId}`);

  // 動的インポートでPptxGenJSを読み込む
  const PptxGenJSModule = await import("pptxgenjs");
  const PptxGenJS = PptxGenJSModule.default;

  // 一時ファイルのリスト（最後にまとめて削除）
  const tempFilesToDelete: string[] = [];

  try {
    // プロジェクト情報を取得
    const project = await getProjectById(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

    // ステップとフレームを取得
    const steps = await getStepsByProjectId(projectId);
    const frames = await getFramesByProjectId(projectId);

    if (!steps || steps.length === 0) {
      throw new Error(`No steps found for project ${projectId}`);
    }

    console.log(`[SlideGenerator] Creating slides for ${steps.length} steps`);

    // PptxGenJSインスタンスを作成
    const pptx = new PptxGenJS();
    pptx.author = "Screen Recording Tutorial Generator";
    pptx.title = project.title;

    // デフォルトのスライドサイズ（16:9）
    pptx.defineLayout({ name: "LAYOUT_16x9", width: 10, height: 5.625 });
    pptx.layout = "LAYOUT_16x9";

    // タイトルスライド
    const titleSlide = pptx.addSlide();
    titleSlide.background = { color: COLORS.primary };

    // タイトルスライドのアクセント装飾（左側のバー）
    titleSlide.addShape("rect", {
      x: 0,
      y: 0,
      w: 0.15,
      h: 5.625,
      fill: { color: COLORS.primaryDark },
    });

    titleSlide.addText(removeEmojis(project.title), {
      x: 0.5,
      y: 1.8,
      w: 9.0,
      h: 1.2,
      fontSize: 40,
      bold: true,
      color: COLORS.white,
      align: "center",
      valign: "middle",
    });

    if (project.description) {
      titleSlide.addText(removeEmojis(project.description), {
        x: 0.5,
        y: 3.2,
        w: 9.0,
        h: 0.8,
        fontSize: 18,
        color: COLORS.white,
        align: "center",
        valign: "middle",
      });
    }

    // ステップ数の表示
    titleSlide.addText(`全${steps.length}ステップ`, {
      x: 0.5,
      y: 4.5,
      w: 9.0,
      h: 0.5,
      fontSize: 14,
      color: COLORS.white,
      align: "center",
    });

    // 各ステップのスライドを作成
    for (const step of steps) {
      const slide = pptx.addSlide();
      slide.background = { color: COLORS.white };

      // 上部のアクセントバー
      slide.addShape("rect", {
        x: 0,
        y: 0,
        w: 10,
        h: 0.08,
        fill: { color: COLORS.primary },
      });

      // ステップ番号バッジ（左上）
      slide.addShape("rect", {
        x: 0.3,
        y: 0.25,
        w: 0.8,
        h: 0.35,
        fill: { color: COLORS.primary },
        rectRadius: 0.05,
      });

      slide.addText(`${step.sortOrder + 1}`, {
        x: 0.3,
        y: 0.25,
        w: 0.8,
        h: 0.35,
        fontSize: 14,
        bold: true,
        color: COLORS.white,
        align: "center",
        valign: "middle",
      });

      // タイトル
      slide.addText(truncateText(step.title, 40), {
        x: 1.2,
        y: 0.2,
        w: 8.3,
        h: 0.45,
        fontSize: 22,
        bold: true,
        color: COLORS.text,
        valign: "middle",
      });

      // 対応するフレームを取得
      const frame = frames.find((f) => f.id === step.frameId);

      // レイアウト: 左側に大きな画像、右側に操作・詳細
      const imageX = 0.3;
      const imageY = 0.8;
      const imageW = 6.2;
      const imageH = 4.5;

      const infoX = 6.7;
      const infoY = 0.8;
      const infoW = 3.0;

      if (frame) {
        try {
          // 画像をダウンロードして一時ファイルに保存
          console.log(`[SlideGenerator] Fetching image for step ${step.sortOrder + 1}: ${frame.imageUrl}`);
          const response = await fetch(frame.imageUrl);
          if (!response.ok) {
            throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
          }
          const imageBuffer = Buffer.from(await response.arrayBuffer());
          const tempImagePath = createTempFilePath(`frame_${frame.id}`, ".jpg");
          await fs.writeFile(tempImagePath, imageBuffer);
          tempFilesToDelete.push(tempImagePath);

          // 画像の背景（軽いシャドウ効果）
          slide.addShape("rect", {
            x: imageX - 0.05,
            y: imageY - 0.05,
            w: imageW + 0.1,
            h: imageH + 0.1,
            fill: { color: COLORS.lightBg },
            rectRadius: 0.05,
          });

          // スライドに画像を追加
          slide.addImage({
            path: tempImagePath,
            x: imageX,
            y: imageY,
            w: imageW,
            h: imageH,
            sizing: { type: "contain", w: imageW, h: imageH },
          });

          console.log(`[SlideGenerator] Added image for step ${step.sortOrder + 1}`);
        } catch (error) {
          console.error(`[SlideGenerator] Error adding image for frame ${frame.id}:`, error);
          // 画像の追加に失敗した場合、プレースホルダーを表示
          slide.addShape("rect", {
            x: imageX,
            y: imageY,
            w: imageW,
            h: imageH,
            fill: { color: COLORS.lightBg },
          });
          slide.addText("画像を読み込めませんでした", {
            x: imageX,
            y: imageY + imageH / 2 - 0.2,
            w: imageW,
            h: 0.4,
            fontSize: 14,
            color: COLORS.textMuted,
            align: "center",
          });
        }
      }

      // 右側の情報パネル背景
      slide.addShape("rect", {
        x: infoX,
        y: infoY,
        w: infoW,
        h: 4.5,
        fill: { color: COLORS.lightBg },
        rectRadius: 0.1,
      });

      // 操作セクション
      slide.addText("操作", {
        x: infoX + 0.15,
        y: infoY + 0.15,
        w: infoW - 0.3,
        h: 0.3,
        fontSize: 11,
        bold: true,
        color: COLORS.primary,
      });

      // 操作内容（指示形式に変換、切り詰め）
      const operationText = truncateText(
        convertToInstructionStyle(step.operation),
        MAX_OPERATION_CHARS
      );
      slide.addText(operationText, {
        x: infoX + 0.15,
        y: infoY + 0.45,
        w: infoW - 0.3,
        h: 1.0,
        fontSize: 12,
        color: COLORS.text,
        valign: "top",
      });

      // 詳細セクション
      slide.addText("詳細", {
        x: infoX + 0.15,
        y: infoY + 1.6,
        w: infoW - 0.3,
        h: 0.3,
        fontSize: 11,
        bold: true,
        color: COLORS.primary,
      });

      // 詳細内容（切り詰め、全文はノートへ）
      const detailText = truncateText(
        convertToInstructionStyle(step.description),
        MAX_DETAIL_CHARS
      );
      slide.addText(detailText, {
        x: infoX + 0.15,
        y: infoY + 1.9,
        w: infoW - 0.3,
        h: 2.3,
        fontSize: 11,
        color: COLORS.textMuted,
        valign: "top",
      });

      // ノートに全文を追加（切り詰めなし）
      const notesText = buildNotesText(step);
      slide.addNotes(notesText);
    }

    // PPTXファイルを一時ファイルに保存
    const tempPptxPath = createTempFilePath(`slides_${projectId}`, ".pptx");
    await pptx.writeFile({ fileName: tempPptxPath });
    tempFilesToDelete.push(tempPptxPath);

    console.log(`[SlideGenerator] PPTX file created: ${tempPptxPath}`);

    // S3にアップロード
    const { storagePut } = await import("./storage");
    const pptxBuffer = await fs.readFile(tempPptxPath);
    const fileKey = `projects/${projectId}/slides/${Date.now()}.pptx`;
    const { url } = await storagePut(
      fileKey,
      pptxBuffer,
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    );

    console.log(`[SlideGenerator] Uploaded to S3: ${url}`);

    return url;
  } finally {
    // 一時ファイルをまとめて削除
    for (const filePath of tempFilesToDelete) {
      try {
        await fs.unlink(filePath);
        console.log(`[SlideGenerator] Deleted temp file: ${filePath}`);
      } catch (error) {
        console.error(`[SlideGenerator] Failed to delete temp file ${filePath}:`, error);
      }
    }
  }
}
