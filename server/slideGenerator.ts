import { promises as fs } from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { getProjectById, getStepsByProjectId, getFramesByProjectId } from "./db";

const execFileAsync = promisify(execFile);

// スライドのテキスト制限
const MAX_OPERATION_CHARS = 60;
const MAX_DETAIL_CHARS = 120;
const MAX_TOC_ITEMS_PER_SLIDE = 8; // 目次1ページあたりの項目数

// カラー定義（プロフェッショナルなパレット）
const COLORS = {
  primary: "2563EB",      // Blue-600
  primaryDark: "1D4ED8",  // Blue-700
  primaryLight: "60A5FA", // Blue-400
  text: "1F2937",         // Gray-800
  textMuted: "6B7280",    // Gray-500
  accent: "3B82F6",       // Blue-500
  highlight: "F59E0B",    // Amber-500 (ハイライト用)
  highlightRing: "EF4444", // Red-500 (リング用)
  white: "FFFFFF",
  lightBg: "F3F4F6",      // Gray-100
};

// ハイライトの種類
type HighlightType = "rect" | "ring" | "arrow" | "none";

// ROI設定
interface ROIConfig {
  enabled: boolean;
  zoomFactor: number; // 1.0 = no zoom, 1.5 = 150% zoom
  focusArea: "center" | "top" | "bottom" | "left" | "right";
}

/**
 * テキストを指定文字数で切り詰め、省略記号を追加
 */
function truncateText(text: string, maxLength: number): string {
  if (!text) return "";
  const cleanText = removeEmojis(text);
  if (cleanText.length <= maxLength) return cleanText;
  return cleanText.substring(0, maxLength - 1) + "…";
}

/**
 * 絵文字を除去
 */
function removeEmojis(text: string): string {
  return text
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")
    .replace(/[\u2600-\u27BF]/g, "")
    .replace(/[\u2300-\u23FF]/g, "")
    .replace(/[\u2B50-\u2B55]/g, "")
    .trim();
}

/**
 * 「状態説明」文を「指示」文に変換
 */
function convertToInstructionStyle(text: string): string {
  if (!text) return "";
  let result = text;
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
 * ffmpegで画像のサイズを取得
 */
async function getImageDimensions(imagePath: string): Promise<{ width: number; height: number }> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "quiet",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=p=0",
      imagePath,
    ], { timeout: 10000 });

    const [width, height] = stdout.trim().split(",").map(Number);
    return { width: width || 1920, height: height || 1080 };
  } catch (error) {
    console.error("[SlideGenerator] Failed to get image dimensions:", error);
    return { width: 1920, height: 1080 };
  }
}

/**
 * ffmpegでROIクロップを実行
 * 画像の中央部分を拡大してクロップ
 */
async function cropImageToROI(
  inputPath: string,
  outputPath: string,
  config: ROIConfig
): Promise<string> {
  if (!config.enabled || config.zoomFactor <= 1.0) {
    // クロップ不要の場合はコピー
    await fs.copyFile(inputPath, outputPath);
    return outputPath;
  }

  try {
    const { width, height } = await getImageDimensions(inputPath);

    // クロップサイズを計算（zoomFactor分小さくクロップ）
    const cropWidth = Math.floor(width / config.zoomFactor);
    const cropHeight = Math.floor(height / config.zoomFactor);

    // クロップ位置を計算
    let cropX = Math.floor((width - cropWidth) / 2);
    let cropY = Math.floor((height - cropHeight) / 2);

    // フォーカスエリアに応じて調整
    switch (config.focusArea) {
      case "top":
        cropY = 0;
        break;
      case "bottom":
        cropY = height - cropHeight;
        break;
      case "left":
        cropX = 0;
        break;
      case "right":
        cropX = width - cropWidth;
        break;
      // "center"はデフォルト
    }

    // ffmpegでクロップして元のサイズにスケール
    await execFileAsync("ffmpeg", [
      "-y",
      "-i", inputPath,
      "-vf", `crop=${cropWidth}:${cropHeight}:${cropX}:${cropY},scale=${width}:${height}`,
      "-q:v", "2",
      outputPath,
    ], { timeout: 30000 });

    return outputPath;
  } catch (error) {
    console.error("[SlideGenerator] ROI crop failed, using original:", error);
    await fs.copyFile(inputPath, outputPath);
    return outputPath;
  }
}

/**
 * スライドにハイライトを追加
 */
function addHighlightToSlide(
  slide: any,
  highlightType: HighlightType,
  imageX: number,
  imageY: number,
  imageW: number,
  imageH: number
): void {
  if (highlightType === "none") return;

  // ハイライト位置（画像の中央下部にフォーカス）
  const highlightX = imageX + imageW * 0.3;
  const highlightY = imageY + imageH * 0.4;
  const highlightW = imageW * 0.4;
  const highlightH = imageH * 0.3;

  switch (highlightType) {
    case "rect":
      // 矩形ハイライト（枠線のみ）
      slide.addShape("rect", {
        x: highlightX,
        y: highlightY,
        w: highlightW,
        h: highlightH,
        fill: { type: "none" },
        line: { color: COLORS.highlight, width: 3, dashType: "solid" },
        rectRadius: 0.05,
      });
      break;

    case "ring":
      // リング（楕円）ハイライト
      const ringCenterX = imageX + imageW * 0.5;
      const ringCenterY = imageY + imageH * 0.5;
      const ringW = imageW * 0.25;
      const ringH = imageH * 0.2;
      slide.addShape("ellipse", {
        x: ringCenterX - ringW / 2,
        y: ringCenterY - ringH / 2,
        w: ringW,
        h: ringH,
        fill: { type: "none" },
        line: { color: COLORS.highlightRing, width: 4, dashType: "solid" },
      });
      break;

    case "arrow":
      // 矢印（右上から中央へ）
      const arrowStartX = imageX + imageW * 0.85;
      const arrowStartY = imageY + imageH * 0.15;
      const arrowEndX = imageX + imageW * 0.55;
      const arrowEndY = imageY + imageH * 0.45;
      slide.addShape("line", {
        x: arrowStartX,
        y: arrowStartY,
        w: arrowEndX - arrowStartX,
        h: arrowEndY - arrowStartY,
        line: { color: COLORS.highlight, width: 3, endArrowType: "triangle" },
      });
      break;
  }
}

/**
 * 目次スライドを作成
 */
function createTableOfContentsSlides(
  pptx: any,
  steps: Array<{ title: string; sortOrder: number }>,
  projectTitle: string
): void {
  const totalSteps = steps.length;
  const totalTocSlides = Math.ceil(totalSteps / MAX_TOC_ITEMS_PER_SLIDE);

  for (let tocPage = 0; tocPage < totalTocSlides; tocPage++) {
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

    // 目次タイトル
    const tocTitle = totalTocSlides > 1
      ? `目次 (${tocPage + 1}/${totalTocSlides})`
      : "目次";

    slide.addText(tocTitle, {
      x: 0.5,
      y: 0.3,
      w: 9.0,
      h: 0.6,
      fontSize: 28,
      bold: true,
      color: COLORS.text,
    });

    // 区切り線
    slide.addShape("rect", {
      x: 0.5,
      y: 0.95,
      w: 9.0,
      h: 0.02,
      fill: { color: COLORS.lightBg },
    });

    // 目次項目
    const startIdx = tocPage * MAX_TOC_ITEMS_PER_SLIDE;
    const endIdx = Math.min(startIdx + MAX_TOC_ITEMS_PER_SLIDE, totalSteps);
    const itemHeight = 0.55;

    for (let i = startIdx; i < endIdx; i++) {
      const step = steps[i];
      const yPos = 1.2 + (i - startIdx) * itemHeight;

      // ステップ番号（円形バッジ）
      slide.addShape("ellipse", {
        x: 0.5,
        y: yPos,
        w: 0.4,
        h: 0.4,
        fill: { color: COLORS.primary },
      });

      slide.addText(`${step.sortOrder + 1}`, {
        x: 0.5,
        y: yPos,
        w: 0.4,
        h: 0.4,
        fontSize: 12,
        bold: true,
        color: COLORS.white,
        align: "center",
        valign: "middle",
      });

      // ステップタイトル
      slide.addText(truncateText(step.title, 50), {
        x: 1.0,
        y: yPos + 0.05,
        w: 8.0,
        h: 0.35,
        fontSize: 14,
        color: COLORS.text,
        valign: "middle",
      });
    }
  }
}

/**
 * 進捗表示を追加（例: 7/21）
 */
function addProgressIndicator(
  slide: any,
  currentStep: number,
  totalSteps: number
): void {
  // 右下に進捗表示
  slide.addText(`${currentStep}/${totalSteps}`, {
    x: 8.8,
    y: 5.2,
    w: 1.0,
    h: 0.3,
    fontSize: 12,
    color: COLORS.textMuted,
    align: "right",
    valign: "middle",
  });

  // プログレスバー（小さなバー）
  const progressWidth = 1.5;
  const progressHeight = 0.06;
  const progressX = 8.3;
  const progressY = 5.15;
  const filledWidth = (currentStep / totalSteps) * progressWidth;

  // 背景バー
  slide.addShape("rect", {
    x: progressX,
    y: progressY,
    w: progressWidth,
    h: progressHeight,
    fill: { color: COLORS.lightBg },
    rectRadius: 0.03,
  });

  // 進捗バー
  if (filledWidth > 0) {
    slide.addShape("rect", {
      x: progressX,
      y: progressY,
      w: filledWidth,
      h: progressHeight,
      fill: { color: COLORS.primary },
      rectRadius: 0.03,
    });
  }
}

/**
 * スライドを生成してS3にアップロードし、URLを返す
 */
export async function generateSlides(projectId: number): Promise<string> {
  console.log(`[SlideGenerator] Starting slide generation for project ${projectId}`);

  const PptxGenJSModule = await import("pptxgenjs");
  const PptxGenJS = PptxGenJSModule.default;

  const tempFilesToDelete: string[] = [];

  try {
    const project = await getProjectById(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

    const steps = await getStepsByProjectId(projectId);
    const frames = await getFramesByProjectId(projectId);

    if (!steps || steps.length === 0) {
      throw new Error(`No steps found for project ${projectId}`);
    }

    console.log(`[SlideGenerator] Creating slides for ${steps.length} steps`);

    const pptx = new PptxGenJS();
    pptx.author = "Screen Recording Tutorial Generator";
    pptx.title = project.title;
    pptx.defineLayout({ name: "LAYOUT_16x9", width: 10, height: 5.625 });
    pptx.layout = "LAYOUT_16x9";

    const totalSteps = steps.length;

    // === タイトルスライド ===
    const titleSlide = pptx.addSlide();
    titleSlide.background = { color: COLORS.primary };

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

    titleSlide.addText(`全${totalSteps}ステップ`, {
      x: 0.5,
      y: 4.5,
      w: 9.0,
      h: 0.5,
      fontSize: 14,
      color: COLORS.white,
      align: "center",
    });

    // === 目次スライド ===
    createTableOfContentsSlides(pptx, steps, project.title);

    // === 各ステップのスライド ===
    // ROI設定（デフォルト: 1.2倍ズーム、中央フォーカス）
    const roiConfig: ROIConfig = {
      enabled: true,
      zoomFactor: 1.2,
      focusArea: "center",
    };

    // ハイライトタイプをステップごとにローテーション
    const highlightTypes: HighlightType[] = ["rect", "ring", "arrow", "none"];

    for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
      const step = steps[stepIndex];
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

      // ステップ番号バッジ
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
        w: 7.0,
        h: 0.45,
        fontSize: 22,
        bold: true,
        color: COLORS.text,
        valign: "middle",
      });

      // 進捗表示
      addProgressIndicator(slide, stepIndex + 1, totalSteps);

      const frame = frames.find((f) => f.id === step.frameId);

      const imageX = 0.3;
      const imageY = 0.8;
      const imageW = 6.2;
      const imageH = 4.5;

      const infoX = 6.7;
      const infoY = 0.8;
      const infoW = 3.0;

      if (frame) {
        try {
          console.log(`[SlideGenerator] Fetching image for step ${step.sortOrder + 1}: ${frame.imageUrl}`);
          const response = await fetch(frame.imageUrl);
          if (!response.ok) {
            throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
          }
          const imageBuffer = Buffer.from(await response.arrayBuffer());
          const tempImagePath = createTempFilePath(`frame_${frame.id}`, ".jpg");
          await fs.writeFile(tempImagePath, imageBuffer);
          tempFilesToDelete.push(tempImagePath);

          // ROIクロップを適用
          const croppedImagePath = createTempFilePath(`frame_${frame.id}_cropped`, ".jpg");
          await cropImageToROI(tempImagePath, croppedImagePath, roiConfig);
          tempFilesToDelete.push(croppedImagePath);

          // 画像の背景
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
            path: croppedImagePath,
            x: imageX,
            y: imageY,
            w: imageW,
            h: imageH,
            sizing: { type: "contain", w: imageW, h: imageH },
          });

          // ハイライトを追加（3ステップごとにタイプを変更）
          const highlightType = highlightTypes[stepIndex % highlightTypes.length];
          addHighlightToSlide(slide, highlightType, imageX, imageY, imageW, imageH);

          console.log(`[SlideGenerator] Added image for step ${step.sortOrder + 1} with highlight: ${highlightType}`);
        } catch (error) {
          console.error(`[SlideGenerator] Error adding image for frame ${frame.id}:`, error);
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

      // ノートに全文を追加
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
