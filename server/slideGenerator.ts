import { promises as fs } from "fs";
import path from "path";
import { getProjectById, getStepsByProjectId, getFramesByProjectId } from "./db";

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

    // PptxGenJSインスタンスを作成
    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_16x9";
    pptx.author = "Screen Recording Tutorial Generator";
    pptx.title = project.title;

    // === レイアウト定数（インチ単位） ===
    const SLIDE_WIDTH = 10.0;
    const SLIDE_HEIGHT = 5.625; // 16:9
    const MARGIN = 0.4;
    
    // 2カラムレイアウト
    const LEFT_COL_X = MARGIN;
    const LEFT_COL_WIDTH = 5.2;
    const RIGHT_COL_X = LEFT_COL_X + LEFT_COL_WIDTH + 0.2;
    const RIGHT_COL_WIDTH = SLIDE_WIDTH - RIGHT_COL_X - MARGIN;
    
    // 画像エリア（左側）
    const IMAGE_X = LEFT_COL_X;
    const IMAGE_Y = 0.8;
    const IMAGE_WIDTH = LEFT_COL_WIDTH;
    const IMAGE_HEIGHT = SLIDE_HEIGHT - IMAGE_Y - MARGIN; // 4.425インチ
    
    // 右側パネル
    const PANEL_X = RIGHT_COL_X;
    const PANEL_Y = 0;
    const PANEL_WIDTH = RIGHT_COL_WIDTH;
    const PANEL_HEIGHT = SLIDE_HEIGHT;
    
    // 右側コンテンツ
    const CONTENT_X = PANEL_X + 0.2;
    const CONTENT_WIDTH = PANEL_WIDTH - 0.4;
    const STEP_NUM_Y = 0.3;
    const TITLE_Y = 0.7;
    const TITLE_HEIGHT = 1.0;
    const ACTION_LABEL_Y = 1.9;
    const ACTION_Y = 2.2;
    const ACTION_HEIGHT = 0.8;
    const DETAIL_LABEL_Y = 3.2;
    const DETAIL_Y = 3.5;
    const DETAIL_HEIGHT = SLIDE_HEIGHT - DETAIL_Y - MARGIN; // 1.725インチ

    // タイトルスライド
    if (project.title) {
      const titleSlide = pptx.addSlide();
      titleSlide.background = { color: "4472C4" };
      titleSlide.addText(project.title, {
        x: 1.0,
        y: 2.0,
        w: SLIDE_WIDTH - 2.0,
        h: 1.5,
        fontSize: 48,
        bold: true,
        color: "FFFFFF",
        align: "center",
        valign: "middle",
      });
    }

    // 各ステップのスライドを作成（2カラムレイアウト）
    for (const step of steps) {
      const slide = pptx.addSlide();

      // 右側パネル（薄いグレーの背景）
      slide.addShape(pptx.ShapeType.rect, {
        x: PANEL_X,
        y: PANEL_Y,
        w: PANEL_WIDTH,
        h: PANEL_HEIGHT,
        fill: { color: "F8F9FA" },
        line: { type: "none" },
      });

      // ステップ番号（右側）
      slide.addText(`STEP ${step.sortOrder + 1}`, {
        x: CONTENT_X,
        y: STEP_NUM_Y,
        w: CONTENT_WIDTH,
        h: 0.3,
        fontSize: 14,
        bold: true,
        color: "4472C4",
      });

      // タイトル（右側、最大24文字に制限）
      const title = step.title.length > 24 ? step.title.substring(0, 21) + "..." : step.title;
      slide.addText(title, {
        x: CONTENT_X,
        y: TITLE_Y,
        w: CONTENT_WIDTH,
        h: TITLE_HEIGHT,
        fontSize: 22,
        bold: true,
        color: "333333",
        valign: "top",
        wrap: true,
      });

      // 対応するフレームを取得（左側に表示）
      const frame = frames.find((f) => f.id === step.frameId);

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

          // スライドに画像を追加（左側、containで全体を表示）
          slide.addImage({
            path: tempImagePath,
            x: IMAGE_X,
            y: IMAGE_Y,
            w: IMAGE_WIDTH,
            h: IMAGE_HEIGHT,
            sizing: { type: "contain", w: IMAGE_WIDTH, h: IMAGE_HEIGHT },
          });

          console.log(`[SlideGenerator] Added image for step ${step.sortOrder + 1}`);
        } catch (error) {
          console.error(`[SlideGenerator] Error adding image for frame ${frame.id}:`, error);
          // 画像の追加に失敗してもスライド作成は続行
        }
      }

      // 操作説明（右側、最大34文字に制限）
      slide.addText("▶ 操作", {
        x: CONTENT_X,
        y: ACTION_LABEL_Y,
        w: CONTENT_WIDTH,
        h: 0.25,
        fontSize: 12,
        bold: true,
        color: "666666",
      });

      const operation = step.operation.length > 34 ? step.operation.substring(0, 31) + "..." : step.operation;
      slide.addText(operation, {
        x: CONTENT_X,
        y: ACTION_Y,
        w: CONTENT_WIDTH,
        h: ACTION_HEIGHT,
        fontSize: 15,
        color: "333333",
        valign: "top",
        wrap: true,
      });

      // 詳細説明（右側、最大60文字に制限）
      slide.addText("📝 詳細", {
        x: CONTENT_X,
        y: DETAIL_LABEL_Y,
        w: CONTENT_WIDTH,
        h: 0.25,
        fontSize: 12,
        bold: true,
        color: "666666",
      });

      const description = step.description.length > 60 ? step.description.substring(0, 57) + "..." : step.description;
      slide.addText(description, {
        x: CONTENT_X,
        y: DETAIL_Y,
        w: CONTENT_WIDTH,
        h: DETAIL_HEIGHT,
        fontSize: 13,
        color: "444444",
        valign: "top",
        wrap: true,
      });
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

/**
 * 一時ファイルのパスを生成
 */
function createTempFilePath(prefix: string, extension: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return path.join("/tmp", `${prefix}_${timestamp}_${random}${extension}`);
}
