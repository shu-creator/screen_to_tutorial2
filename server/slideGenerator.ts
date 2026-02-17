import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type PptxGenJS from "pptxgenjs";
import { ENV, type SlidePreset } from "./_core/env";
import { getProjectById, getStepsByProjectId, getFramesByProjectId } from "./db";
import { readBinaryFromSource } from "./storage";
import {
  buildLegacyRenderableStepsFromArtifact,
  buildStepsArtifactFromDb,
  loadStepsArtifact,
  saveStepsArtifact,
} from "./stepsArtifact";
import {
  truncateAtSentence,
  ensureTerminalPunctuation,
  anonymizeOnScreenStepNumbers,
  buildDisplayTitleMap,
  applyFinalStepCompletionFix,
  formatProjectionOperation,
  formatProjectionDetail,
} from "./slideText";

const execFileAsync = promisify(execFile);
type PptxSlide = ReturnType<PptxGenJS["addSlide"]>;

// スライドのテキスト制限
const MAX_OPERATION_CHARS = 60;
const MAX_DETAIL_CHARS = 120;
const MAX_TOC_ITEMS_PER_SLIDE = 8; // 目次1ページあたりの項目数

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface TextConstraint {
  maxUnitsPerLine: number;
  maxLines: number;
}

interface SlideTemplateConfig {
  preset: SlidePreset;
  imageRect: Rect;
  panelRect: Rect;
  panelPaddingX: number;
  panelPaddingY: number;
  titleRect: Rect;
  titleFontSize: number;
  stepBadgeRect: Rect;
  stepBadgeShape: "rect" | "ellipse";
  stepBadgeFontSize: number;
  progressFontSize: number;
  sectionTitleFontSize: number;
  operationFontSize: number;
  detailFontSize: number;
  operationLabelY: number;
  operationTextY: number;
  operationTextHeight: number;
  detailLabelY: number;
  detailTextY: number;
  detailTextHeight: number;
  useProjectionTextFormatter: boolean;
  operationConstraint: TextConstraint;
  detailConstraint: TextConstraint;
}

interface CroppingConfig {
  minAreaRatio: number;
  maxAreaRatio: number;
  paddingRatio: number;
  minCropWidthPx: number;
  spotlightOpacity: number;
}

interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

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

const SLIDE_TEMPLATE_CONFIG: Record<SlidePreset, SlideTemplateConfig> = {
  default: {
    preset: "default",
    imageRect: { x: 0.3, y: 0.8, w: 6.2, h: 4.5 },
    panelRect: { x: 6.7, y: 0.8, w: 3.0, h: 4.5 },
    panelPaddingX: 0.15,
    panelPaddingY: 0.15,
    titleRect: { x: 1.2, y: 0.2, w: 7.0, h: 0.45 },
    titleFontSize: 22,
    stepBadgeRect: { x: 0.3, y: 0.25, w: 0.8, h: 0.35 },
    stepBadgeShape: "rect",
    stepBadgeFontSize: 14,
    progressFontSize: 12,
    sectionTitleFontSize: 11,
    operationFontSize: 12,
    detailFontSize: 11,
    operationLabelY: 0.15,
    operationTextY: 0.45,
    operationTextHeight: 1.0,
    detailLabelY: 1.6,
    detailTextY: 1.9,
    detailTextHeight: 2.3,
    useProjectionTextFormatter: false,
    operationConstraint: { maxUnitsPerLine: 20, maxLines: 4 },
    detailConstraint: { maxUnitsPerLine: 20, maxLines: 6 },
  },
  training: {
    preset: "training",
    imageRect: { x: 0.3, y: 0.8, w: 6.0, h: 4.5 },
    panelRect: { x: 6.5, y: 0.8, w: 3.2, h: 4.5 },
    panelPaddingX: 0.16,
    panelPaddingY: 0.14,
    titleRect: { x: 0.95, y: 0.2, w: 7.3, h: 0.55 },
    titleFontSize: 28,
    stepBadgeRect: { x: 0.3, y: 0.16, w: 0.52, h: 0.52 },
    stepBadgeShape: "ellipse",
    stepBadgeFontSize: 18,
    progressFontSize: 15,
    sectionTitleFontSize: 16,
    operationFontSize: 18,
    detailFontSize: 16,
    operationLabelY: 0.16,
    operationTextY: 0.52,
    operationTextHeight: 1.55,
    detailLabelY: 2.1,
    detailTextY: 2.45,
    detailTextHeight: 1.85,
    useProjectionTextFormatter: true,
    operationConstraint: { maxUnitsPerLine: 14.5, maxLines: 2 },
    detailConstraint: { maxUnitsPerLine: 15.5, maxLines: 4 },
  },
};

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
}, overflow?: {
  operationOverflow?: string;
  detailOverflow?: string;
}): string {
  const parts: string[] = [];
  parts.push(`【${step.title}】`);
  parts.push("");
  parts.push(`操作: ${step.operation}`);
  if (overflow?.operationOverflow) {
    parts.push(`操作（省略分）: ${overflow.operationOverflow}`);
  }
  parts.push("");
  parts.push(`詳細:`);
  parts.push(step.description);
  if (overflow?.detailOverflow) {
    parts.push("");
    parts.push(`詳細（省略分）:`);
    parts.push(overflow.detailOverflow);
  }
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
  return path.join(os.tmpdir(), `${prefix}_${timestamp}_${random}${extension}`);
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizedToPixelRect(
  rect: NormalizedRect,
  dims: { width: number; height: number },
): PixelRect {
  return {
    x: rect.x * dims.width,
    y: rect.y * dims.height,
    w: rect.w * dims.width,
    h: rect.h * dims.height,
  };
}

function pixelToNormalizedRect(
  rect: PixelRect,
  dims: { width: number; height: number },
): NormalizedRect {
  return {
    x: rect.x / dims.width,
    y: rect.y / dims.height,
    w: rect.w / dims.width,
    h: rect.h / dims.height,
  };
}

function getCroppingConfig(): CroppingConfig {
  return {
    minAreaRatio: ENV.slideRoiMinAreaRatio,
    maxAreaRatio: ENV.slideRoiMaxAreaRatio,
    paddingRatio: ENV.slideRoiPaddingRatio,
    minCropWidthPx: ENV.slideRoiMinCropWidthPx,
    spotlightOpacity: ENV.slideSpotlightOpacity,
  };
}

function isReliableRoiRegion(
  region: NormalizedRect | null,
  croppingConfig: CroppingConfig,
): boolean {
  if (!region) return false;
  const areaRatio = region.w * region.h;
  return (
    areaRatio >= croppingConfig.minAreaRatio &&
    areaRatio <= croppingConfig.maxAreaRatio
  );
}

function buildCropRectFromRegion(
  region: NormalizedRect,
  dims: { width: number; height: number },
  targetAspect: number,
  croppingConfig: CroppingConfig,
): PixelRect {
  const roi = normalizedToPixelRect(region, dims);
  const padX = roi.w * croppingConfig.paddingRatio;
  const padY = roi.h * croppingConfig.paddingRatio;

  let width = roi.w + padX * 2;
  let height = roi.h + padY * 2;
  width = Math.max(width, Math.min(croppingConfig.minCropWidthPx, dims.width));

  if (width / height > targetAspect) {
    height = width / targetAspect;
  } else {
    width = height * targetAspect;
  }

  if (width > dims.width) {
    width = dims.width;
    height = width / targetAspect;
  }
  if (height > dims.height) {
    height = dims.height;
    width = height * targetAspect;
  }

  const centerX = roi.x + roi.w / 2;
  const centerY = roi.y + roi.h / 2;

  const x = clamp(centerX - width / 2, 0, Math.max(0, dims.width - width));
  const y = clamp(centerY - height / 2, 0, Math.max(0, dims.height - height));

  return {
    x: Math.max(0, Math.floor(x)),
    y: Math.max(0, Math.floor(y)),
    w: Math.max(1, Math.floor(width)),
    h: Math.max(1, Math.floor(height)),
  };
}

function getRegionInCropSpace(
  region: NormalizedRect,
  cropRect: PixelRect,
  dims: { width: number; height: number },
): NormalizedRect | null {
  const regionPx = normalizedToPixelRect(region, dims);
  const x1 = clamp(regionPx.x, cropRect.x, cropRect.x + cropRect.w);
  const y1 = clamp(regionPx.y, cropRect.y, cropRect.y + cropRect.h);
  const x2 = clamp(
    regionPx.x + regionPx.w,
    cropRect.x,
    cropRect.x + cropRect.w,
  );
  const y2 = clamp(
    regionPx.y + regionPx.h,
    cropRect.y,
    cropRect.y + cropRect.h,
  );

  const width = x2 - x1;
  const height = y2 - y1;
  if (width <= 0 || height <= 0) {
    return null;
  }

  return {
    x: (x1 - cropRect.x) / cropRect.w,
    y: (y1 - cropRect.y) / cropRect.h,
    w: width / cropRect.w,
    h: height / cropRect.h,
  };
}

function defaultCenterRegion(): NormalizedRect {
  return { x: 0.34, y: 0.28, w: 0.32, h: 0.34 };
}

const CLICK_HINT_KEYWORDS = [
  "クリック",
  "選択",
  "押す",
  "タップ",
  "実行",
  "開く",
  "入力",
];

function isClickFocusedStep(operation: string, detail: string): boolean {
  const text = `${operation} ${detail}`;
  return CLICK_HINT_KEYWORDS.some((keyword) => text.includes(keyword));
}

async function cropImageByPixelRect(
  inputPath: string,
  outputPath: string,
  cropRect: PixelRect,
): Promise<string> {
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-i",
      inputPath,
      "-vf",
      `crop=${cropRect.w}:${cropRect.h}:${cropRect.x}:${cropRect.y}`,
      "-q:v",
      "2",
      outputPath,
    ],
    { timeout: 30000 },
  );
  return outputPath;
}

/**
 * 前後フレームの差分から変更領域を検出
 * 返り値は画像全体に対する割合（0〜1）
 */
async function detectChangedRegion(
  prevImagePath: string,
  currImagePath: string,
): Promise<{ x: number; y: number; w: number; h: number } | null> {
  const diffPath = createTempFilePath("diff", ".png");

  try {
    // 差分画像を作成（変更箇所が明るく、未変更箇所が暗くなる）
    await execFileAsync("ffmpeg", [
      "-y",
      "-i", prevImagePath,
      "-i", currImagePath,
      "-filter_complex", "[0][1]blend=all_mode=difference,format=gray",
      "-q:v", "2",
      diffPath,
    ], { timeout: 15000 });

    // 差分画像のサイズを取得
    const dims = await getImageDimensions(diffPath);

    // cropdetectで変更領域の境界を検出
    // 閾値30: 微小な差異（圧縮ノイズ等）を無視
    const { stderr } = await execFileAsync("ffmpeg", [
      "-i", diffPath,
      "-vf", "cropdetect=30:2:0",
      "-f", "null", "-",
    ], { timeout: 15000 });

    // cropdetect出力: crop=W:H:X:Y
    const cropMatches = stderr.match(/crop=(\d+):(\d+):(\d+):(\d+)/g);
    if (!cropMatches || cropMatches.length === 0) return null;

    // 最後の安定したcrop値を使用
    const lastMatch = cropMatches[cropMatches.length - 1].match(/crop=(\d+):(\d+):(\d+):(\d+)/);
    if (!lastMatch) return null;

    const cropW = parseInt(lastMatch[1]);
    const cropH = parseInt(lastMatch[2]);
    const cropX = parseInt(lastMatch[3]);
    const cropY = parseInt(lastMatch[4]);

    // 変更領域が画像のほぼ全体（90%以上）の場合はハイライト不要
    // （画面全体が切り替わった場合）
    if (cropW >= dims.width * 0.9 && cropH >= dims.height * 0.9) {
      return null;
    }

    // 変更領域が小さすぎる場合もスキップ（ノイズ除去）
    if (cropW < dims.width * 0.03 || cropH < dims.height * 0.03) {
      return null;
    }

    // 画像全体に対する割合に変換
    return {
      x: cropX / dims.width,
      y: cropY / dims.height,
      w: cropW / dims.width,
      h: cropH / dims.height,
    };
  } catch (error) {
    console.error("[SlideGenerator] Failed to detect changed region:", error);
    return null;
  } finally {
    await fs.unlink(diffPath).catch(() => {});
  }
}

/**
 * スライドにハイライトを追加（変更領域ベース）
 * region: 画像全体に対する変更領域の割合（0〜1）
 */
function addHighlightToSlide(
  slide: PptxSlide,
  highlightType: HighlightType,
  imageX: number,
  imageY: number,
  imageW: number,
  imageH: number,
  region: { x: number; y: number; w: number; h: number }
): void {
  if (highlightType === "none") return;

  // 変更領域をスライド座標に変換
  const regionX = imageX + region.x * imageW;
  const regionY = imageY + region.y * imageH;
  const regionW = region.w * imageW;
  const regionH = region.h * imageH;

  // パディングを追加（少し余裕を持たせる）
  const padX = regionW * 0.08;
  const padY = regionH * 0.08;
  const paddedX = Math.max(imageX, regionX - padX);
  const paddedY = Math.max(imageY, regionY - padY);
  const paddedW = Math.min(imageX + imageW - paddedX, regionW + padX * 2);
  const paddedH = Math.min(imageY + imageH - paddedY, regionH + padY * 2);

  switch (highlightType) {
    case "rect":
      // 矩形ハイライト（枠線のみ）
      slide.addShape("rect", {
        x: paddedX,
        y: paddedY,
        w: paddedW,
        h: paddedH,
        fill: { type: "none" },
        line: { color: COLORS.highlight, width: 3, dashType: "solid" },
        rectRadius: 0.05,
      });
      break;

    case "ring":
      // リング（楕円）ハイライト
      slide.addShape("ellipse", {
        x: paddedX,
        y: paddedY,
        w: paddedW,
        h: paddedH,
        fill: { type: "none" },
        line: { color: COLORS.highlightRing, width: 4, dashType: "solid" },
      });
      break;

    case "arrow": {
      // 変更領域の中心を指す矢印
      const targetX = paddedX + paddedW / 2;
      const targetY = paddedY + paddedH / 2;
      // 矢印の始点: 画像の右上方向から
      const arrowStartX = Math.min(imageX + imageW - 0.2, targetX + 1.5);
      const arrowStartY = Math.max(imageY + 0.2, targetY - 1.0);
      slide.addShape("line", {
        x: arrowStartX,
        y: arrowStartY,
        w: targetX - arrowStartX,
        h: targetY - arrowStartY,
        line: { color: COLORS.highlight, width: 3, endArrowType: "triangle" },
      });
      break;
    }
  }
}

function addRectHighlightToSlide(
  slide: PptxSlide,
  imageRect: Rect,
  region: NormalizedRect,
  lineWidth: number,
): void {
  const regionX = imageRect.x + region.x * imageRect.w;
  const regionY = imageRect.y + region.y * imageRect.h;
  const regionW = region.w * imageRect.w;
  const regionH = region.h * imageRect.h;
  const padX = regionW * 0.07;
  const padY = regionH * 0.07;
  const x = Math.max(imageRect.x, regionX - padX);
  const y = Math.max(imageRect.y, regionY - padY);
  const w = Math.min(imageRect.x + imageRect.w - x, regionW + padX * 2);
  const h = Math.min(imageRect.y + imageRect.h - y, regionH + padY * 2);

  slide.addShape("rect", {
    x,
    y,
    w,
    h,
    fill: { type: "none" },
    line: { color: COLORS.highlight, width: lineWidth, dashType: "solid" },
    rectRadius: 0.05,
  });
}

function addSpotlightToSlide(
  slide: PptxSlide,
  imageRect: Rect,
  region: NormalizedRect,
  opacity: number,
): void {
  const targetX = imageRect.x + region.x * imageRect.w;
  const targetY = imageRect.y + region.y * imageRect.h;
  const targetW = region.w * imageRect.w;
  const targetH = region.h * imageRect.h;
  const rightEdge = imageRect.x + imageRect.w;
  const bottomEdge = imageRect.y + imageRect.h;
  const transparency = Math.round((1 - clamp(opacity, 0, 1)) * 100);
  const fill = { color: "000000", transparency };

  const topHeight = targetY - imageRect.y;
  if (topHeight > 0) {
    slide.addShape("rect", {
      x: imageRect.x,
      y: imageRect.y,
      w: imageRect.w,
      h: topHeight,
      line: { color: "000000", transparency: 100 },
      fill,
    });
  }

  const bottomHeight = bottomEdge - (targetY + targetH);
  if (bottomHeight > 0) {
    slide.addShape("rect", {
      x: imageRect.x,
      y: targetY + targetH,
      w: imageRect.w,
      h: bottomHeight,
      line: { color: "000000", transparency: 100 },
      fill,
    });
  }

  const leftWidth = targetX - imageRect.x;
  if (leftWidth > 0) {
    slide.addShape("rect", {
      x: imageRect.x,
      y: targetY,
      w: leftWidth,
      h: targetH,
      line: { color: "000000", transparency: 100 },
      fill,
    });
  }

  const rightWidth = rightEdge - (targetX + targetW);
  if (rightWidth > 0) {
    slide.addShape("rect", {
      x: targetX + targetW,
      y: targetY,
      w: rightWidth,
      h: targetH,
      line: { color: "000000", transparency: 100 },
      fill,
    });
  }
}

/**
 * 目次スライドを作成
 */
function createTableOfContentsSlides(
  pptx: PptxGenJS,
  steps: Array<{ title: string; displayTitle: string; sortOrder: number }>,
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
      slide.addText(truncateText(step.displayTitle, 50), {
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
  slide: PptxSlide,
  currentStep: number,
  totalSteps: number,
  fontSize: number = 12,
): void {
  // 右下に進捗表示
  slide.addText(`${currentStep}/${totalSteps}`, {
    x: 8.8,
    y: fontSize >= 15 ? 5.15 : 5.2,
    w: 1.0,
    h: 0.3,
    fontSize,
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
  const PptxGenJSConstructor = PptxGenJSModule.default;

  const tempFilesToDelete: string[] = [];

  try {
    const project = await getProjectById(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

    const frames = await getFramesByProjectId(projectId);
    const dbSteps = await getStepsByProjectId(projectId);

    type SlideStep = {
      id: number;
      frameId: number;
      sortOrder: number;
      title: string;
      operation: string;
      description: string;
      narration: string | null;
      audioUrl: string | null;
      audioKey: string | null;
    };

    let steps: SlideStep[] = dbSteps.map((step) => ({
      id: step.id,
      frameId: step.frameId,
      sortOrder: step.sortOrder,
      title: step.title,
      operation: step.operation,
      description: step.description,
      narration: step.narration ?? null,
      audioUrl: step.audioUrl ?? null,
      audioKey: step.audioKey ?? null,
    }));
    const artifact = await loadStepsArtifact(projectId);
    if (artifact && artifact.steps.length > 0) {
      steps = buildLegacyRenderableStepsFromArtifact(projectId, artifact, frames);
    } else if (dbSteps.length > 0) {
      const fallbackArtifact = buildStepsArtifactFromDb(project, frames, dbSteps);
      await saveStepsArtifact(projectId, fallbackArtifact);
    }

    if (!steps || steps.length === 0) {
      throw new Error(`No steps found for project ${projectId}`);
    }

    // テキスト整形: 重複タイトルのユニーク化
    const displayTitleMap = buildDisplayTitleMap(steps);
    const stepsWithDisplayTitle = steps.map((s) => ({
      ...s,
      displayTitle: displayTitleMap.get(s.id) ?? s.title,
    }));

    // テキスト整形: 最終ステップの安全な補正
    if (stepsWithDisplayTitle.length > 0) {
      const lastIdx = stepsWithDisplayTitle.length - 1;
      const last = stepsWithDisplayTitle[lastIdx];
      const fixed = applyFinalStepCompletionFix(last, lastIdx, stepsWithDisplayTitle.length);
      if (fixed.modified) {
        stepsWithDisplayTitle[lastIdx] = {
          ...last,
          operation: fixed.operation,
          description: fixed.description,
        };
        console.log("[SlideGenerator] Final step corrected from hover to completion check");
      }
    }

    console.log(`[SlideGenerator] Creating slides for ${stepsWithDisplayTitle.length} steps`);

    const pptx = new PptxGenJSConstructor();
    pptx.author = "Screen Recording Tutorial Generator";
    pptx.title = project.title;
    pptx.defineLayout({ name: "LAYOUT_16x9", width: 10, height: 5.625 });
    pptx.layout = "LAYOUT_16x9";

    const totalSteps = stepsWithDisplayTitle.length;

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
    createTableOfContentsSlides(pptx, stepsWithDisplayTitle, project.title);

    // === 各ステップのスライド ===
    const slideTemplate = SLIDE_TEMPLATE_CONFIG[ENV.slidePreset];
    const isTrainingPreset = slideTemplate.preset === "training";
    const croppingConfig = getCroppingConfig();

    const roiConfig: ROIConfig = {
      enabled: true,
      zoomFactor: 1.2,
      focusArea: "center",
    };
    const activeHighlightTypes: HighlightType[] = ["rect", "ring", "arrow"];
    let prevCroppedImagePath: string | null = null;

    const frameById = new Map(frames.map((frame) => [frame.id, frame]));
    const frameTempPathCache = new Map<number, string>();
    const getFrameTempPath = async (frameId: number): Promise<string | null> => {
      if (frameTempPathCache.has(frameId)) {
        return frameTempPathCache.get(frameId) ?? null;
      }
      const frame = frameById.get(frameId);
      if (!frame) return null;

      const imageBuffer = await readBinaryFromSource(frame.imageUrl);
      const tempImagePath = createTempFilePath(`frame_${frame.id}`, ".jpg");
      await fs.writeFile(tempImagePath, imageBuffer);
      tempFilesToDelete.push(tempImagePath);
      frameTempPathCache.set(frameId, tempImagePath);
      return tempImagePath;
    };

    for (let stepIndex = 0; stepIndex < stepsWithDisplayTitle.length; stepIndex++) {
      const step = stepsWithDisplayTitle[stepIndex];
      const slide = pptx.addSlide();
      slide.background = { color: COLORS.white };

      slide.addShape("rect", {
        x: 0,
        y: 0,
        w: 10,
        h: 0.08,
        fill: { color: COLORS.primary },
      });

      if (slideTemplate.stepBadgeShape === "ellipse") {
        slide.addShape("ellipse", {
          x: slideTemplate.stepBadgeRect.x,
          y: slideTemplate.stepBadgeRect.y,
          w: slideTemplate.stepBadgeRect.w,
          h: slideTemplate.stepBadgeRect.h,
          fill: { color: COLORS.primary },
        });
      } else {
        slide.addShape("rect", {
          x: slideTemplate.stepBadgeRect.x,
          y: slideTemplate.stepBadgeRect.y,
          w: slideTemplate.stepBadgeRect.w,
          h: slideTemplate.stepBadgeRect.h,
          fill: { color: COLORS.primary },
          rectRadius: 0.05,
        });
      }

      slide.addText(`${step.sortOrder + 1}`, {
        x: slideTemplate.stepBadgeRect.x,
        y: slideTemplate.stepBadgeRect.y,
        w: slideTemplate.stepBadgeRect.w,
        h: slideTemplate.stepBadgeRect.h,
        fontSize: slideTemplate.stepBadgeFontSize,
        bold: true,
        color: COLORS.white,
        align: "center",
        valign: "middle",
      });

      const titleCharLimit = isTrainingPreset ? 32 : 40;
      slide.addText(truncateText(step.displayTitle, titleCharLimit), {
        x: slideTemplate.titleRect.x,
        y: slideTemplate.titleRect.y,
        w: slideTemplate.titleRect.w,
        h: slideTemplate.titleRect.h,
        fontSize: slideTemplate.titleFontSize,
        bold: true,
        color: COLORS.text,
        valign: "middle",
      });

      addProgressIndicator(
        slide,
        stepIndex + 1,
        totalSteps,
        slideTemplate.progressFontSize,
      );

      const frame = frameById.get(step.frameId);
      const imageRect = slideTemplate.imageRect;
      const panelRect = slideTemplate.panelRect;
      let operationOverflow = "";
      let detailOverflow = "";

      if (frame) {
        try {
          const baseImagePath = await getFrameTempPath(frame.id);
          if (!baseImagePath) {
            throw new Error(`Frame image not found: ${frame.id}`);
          }

          const croppedImagePath = createTempFilePath(
            `frame_${frame.id}_cropped`,
            ".jpg",
          );
          tempFilesToDelete.push(croppedImagePath);

          let imagePathForSlide = croppedImagePath;
          let highlightType: HighlightType = "none";
          let highlightRegion: NormalizedRect | null = null;

          if (isTrainingPreset) {
            const imageDims = await getImageDimensions(baseImagePath);
            const targetAspect = imageRect.w / imageRect.h;
            let candidateRegion: NormalizedRect | null = null;

            if (stepIndex > 0) {
              const prevFrameId = stepsWithDisplayTitle[stepIndex - 1].frameId;
              const prevPath = await getFrameTempPath(prevFrameId);
              if (prevPath) {
                const detected = await detectChangedRegion(prevPath, baseImagePath);
                if (isReliableRoiRegion(detected, croppingConfig)) {
                  candidateRegion = detected;
                }
              }
            }

            if (candidateRegion) {
              const cropRect = buildCropRectFromRegion(
                candidateRegion,
                imageDims,
                targetAspect,
                croppingConfig,
              );
              try {
                await cropImageByPixelRect(baseImagePath, croppedImagePath, cropRect);
                const adjustedRegion = getRegionInCropSpace(
                  candidateRegion,
                  cropRect,
                  imageDims,
                );
                highlightRegion = adjustedRegion ?? defaultCenterRegion();
              } catch (error) {
                console.error("[SlideGenerator] ROI crop failed, fallback to full frame", error);
                await fs.copyFile(baseImagePath, croppedImagePath);
                highlightRegion = candidateRegion;
              }
            } else {
              await fs.copyFile(baseImagePath, croppedImagePath);
            }

            if (!highlightRegion && isClickFocusedStep(step.operation, step.description)) {
              highlightRegion = defaultCenterRegion();
            }

            if (highlightRegion) {
              highlightType = "rect";
            }
          } else {
            await cropImageToROI(baseImagePath, croppedImagePath, roiConfig);

            if (prevCroppedImagePath && stepIndex > 0) {
              const changedRegion = await detectChangedRegion(
                prevCroppedImagePath,
                croppedImagePath,
              );
              if (changedRegion) {
                highlightType =
                  activeHighlightTypes[stepIndex % activeHighlightTypes.length];
                highlightRegion = changedRegion;
              }
            }
            prevCroppedImagePath = croppedImagePath;
          }

          slide.addShape("rect", {
            x: imageRect.x - 0.05,
            y: imageRect.y - 0.05,
            w: imageRect.w + 0.1,
            h: imageRect.h + 0.1,
            fill: { color: COLORS.lightBg },
            rectRadius: 0.05,
          });

          slide.addImage({
            path: imagePathForSlide,
            x: imageRect.x,
            y: imageRect.y,
            w: imageRect.w,
            h: imageRect.h,
            sizing: { type: "contain", w: imageRect.w, h: imageRect.h },
          });

          if (isTrainingPreset && highlightRegion) {
            addSpotlightToSlide(
              slide,
              imageRect,
              highlightRegion,
              croppingConfig.spotlightOpacity,
            );
            addRectHighlightToSlide(slide, imageRect, highlightRegion, 5);
          }

          if (!isTrainingPreset && highlightRegion && highlightType !== "none") {
            addHighlightToSlide(
              slide,
              highlightType,
              imageRect.x,
              imageRect.y,
              imageRect.w,
              imageRect.h,
              highlightRegion,
            );
          }

          console.log(
            `[SlideGenerator] Added image for step ${step.sortOrder + 1} (highlight: ${highlightType})`,
          );
        } catch (error) {
          console.error(`[SlideGenerator] Error adding image for frame ${frame.id}:`, error);
          slide.addShape("rect", {
            x: imageRect.x,
            y: imageRect.y,
            w: imageRect.w,
            h: imageRect.h,
            fill: { color: COLORS.lightBg },
          });
          slide.addText("画像を読み込めませんでした", {
            x: imageRect.x,
            y: imageRect.y + imageRect.h / 2 - 0.2,
            w: imageRect.w,
            h: 0.4,
            fontSize: 14,
            color: COLORS.textMuted,
            align: "center",
          });
        }
      }

      slide.addShape("rect", {
        x: panelRect.x,
        y: panelRect.y,
        w: panelRect.w,
        h: panelRect.h,
        fill: { color: COLORS.lightBg },
        rectRadius: 0.1,
      });

      const panelTextX = panelRect.x + slideTemplate.panelPaddingX;
      const panelTextW = panelRect.w - slideTemplate.panelPaddingX * 2;
      const operationRaw = ensureTerminalPunctuation(
        convertToInstructionStyle(removeEmojis(step.operation)),
      );
      const detailRaw = ensureTerminalPunctuation(
        convertToInstructionStyle(removeEmojis(step.description)),
      );

      slide.addText("操作", {
        x: panelTextX,
        y: panelRect.y + slideTemplate.operationLabelY,
        w: panelTextW,
        h: 0.3,
        fontSize: slideTemplate.sectionTitleFontSize,
        bold: true,
        color: COLORS.primary,
      });

      let operationText: string;
      let detailText: string;
      if (slideTemplate.useProjectionTextFormatter) {
        const operationResult = formatProjectionOperation(
          operationRaw,
          slideTemplate.operationConstraint,
        );
        const detailResult = formatProjectionDetail(
          operationRaw,
          detailRaw,
          slideTemplate.detailConstraint,
        );
        operationText = operationResult.text;
        detailText = detailResult.text;
        operationOverflow = operationResult.overflow;
        detailOverflow = detailResult.overflow;
      } else {
        operationText = truncateAtSentence(operationRaw, MAX_OPERATION_CHARS);
        detailText = truncateAtSentence(
          ensureTerminalPunctuation(
            anonymizeOnScreenStepNumbers(detailRaw),
          ),
          MAX_DETAIL_CHARS,
        );
      }

      slide.addText(operationText, {
        x: panelTextX,
        y: panelRect.y + slideTemplate.operationTextY,
        w: panelTextW,
        h: slideTemplate.operationTextHeight,
        fontSize: slideTemplate.operationFontSize,
        bold: isTrainingPreset,
        color: COLORS.text,
        valign: "top",
      });

      slide.addText("詳細", {
        x: panelTextX,
        y: panelRect.y + slideTemplate.detailLabelY,
        w: panelTextW,
        h: 0.3,
        fontSize: slideTemplate.sectionTitleFontSize,
        bold: true,
        color: COLORS.primary,
      });

      slide.addText(detailText, {
        x: panelTextX,
        y: panelRect.y + slideTemplate.detailTextY,
        w: panelTextW,
        h: slideTemplate.detailTextHeight,
        fontSize: slideTemplate.detailFontSize,
        color: isTrainingPreset ? COLORS.text : COLORS.textMuted,
        valign: "top",
      });

      const notesText = buildNotesText(step, {
        operationOverflow,
        detailOverflow,
      });
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
