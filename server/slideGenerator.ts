import PptxGenJS from "pptxgenjs";
import * as db from "./db";
import { storagePut } from "./storage";
import { nanoid } from "nanoid";
import fs from "fs/promises";
import { createTempFilePath, safeTempFileDelete } from "./tempFileManager";

/**
 * プロジェクトのステップからPowerPointスライドを生成
 */
export async function generateSlides(projectId: number): Promise<string> {
  console.log(`[SlideGenerator] Starting slide generation for project ${projectId}`);

  // 一時ファイルのリスト（最後にまとめて削除）
  const tempFilesToDelete: string[] = [];

  try {
    // プロジェクト情報を取得
    const project = await db.getProjectById(projectId);
    if (!project) {
      throw new Error("プロジェクトが見つかりません");
    }

    // ステップとフレームを取得
    const steps = await db.getStepsByProjectId(projectId);
    const frames = await db.getFramesByProjectId(projectId);

    if (steps.length === 0) {
      throw new Error("ステップが見つかりません");
    }

    console.log(`[SlideGenerator] Creating slides for ${steps.length} steps`);

    // PowerPointプレゼンテーションを作成
    const pptx = new PptxGenJS();

    // プレゼンテーション設定
    pptx.author = "TutorialGen";
    pptx.company = "TutorialGen";
    pptx.title = project.title;
    pptx.subject = project.description || "";

    // タイトルスライド
    const titleSlide = pptx.addSlide();
    titleSlide.background = { color: "4472C4" };

    titleSlide.addText(project.title, {
      x: 0.5,
      y: 2.0,
      w: "90%",
      h: 1.5,
      fontSize: 44,
      bold: true,
      color: "FFFFFF",
      align: "center",
    });

    if (project.description) {
      titleSlide.addText(project.description, {
        x: 0.5,
        y: 3.5,
        w: "90%",
        h: 1.0,
        fontSize: 24,
        color: "FFFFFF",
        align: "center",
      });
    }

    // 各ステップのスライドを作成
    for (const step of steps) {
      const slide = pptx.addSlide();

      // ステップ番号
      slide.addText(`ステップ ${step.sortOrder + 1}`, {
        x: 0.5,
        y: 0.3,
        w: "90%",
        h: 0.5,
        fontSize: 16,
        color: "666666",
      });

      // タイトル
      slide.addText(step.title, {
        x: 0.5,
        y: 0.8,
        w: "90%",
        h: 0.8,
        fontSize: 32,
        bold: true,
        color: "333333",
      });

      // 対応するフレームを取得
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

          // スライドに画像を追加
          slide.addImage({
            path: tempImagePath,
            x: 0.5,
            y: 1.8,
            w: 9.0,
            h: 5.0,
            sizing: { type: "contain", w: 9.0, h: 5.0 },
          });

          console.log(`[SlideGenerator] Added image for step ${step.sortOrder + 1}`);
        } catch (error) {
          console.error(`[SlideGenerator] Error adding image for frame ${frame.id}:`, error);
          // 画像の追加に失敗してもスライド作成は続行
        }
      }

      // 操作説明
      slide.addText(`操作: ${step.operation}`, {
        x: 0.5,
        y: 7.0,
        w: "90%",
        h: 0.4,
        fontSize: 14,
        color: "444444",
      });

      // 詳細説明
      slide.addText(step.description, {
        x: 0.5,
        y: 7.5,
        w: "90%",
        h: 0.8,
        fontSize: 12,
        color: "666666",
      });

      // ノートにナレーションを追加
      if (step.narration) {
        slide.addNotes(step.narration);
      }
    }

    // 一時ファイルに保存
    const tempPptxPath = createTempFilePath(`slides_${projectId}`, ".pptx");
    tempFilesToDelete.push(tempPptxPath);

    console.log(`[SlideGenerator] Writing PPTX file...`);
    await pptx.writeFile({ fileName: tempPptxPath });
    console.log(`[SlideGenerator] PPTX file written successfully`);

    // S3にアップロード
    const pptxBuffer = await fs.readFile(tempPptxPath);
    const fileKey = `projects/${projectId}/slides/${nanoid()}.pptx`;
    const { url: pptxUrl } = await storagePut(
      fileKey,
      pptxBuffer,
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    );

    console.log(`[SlideGenerator] Slide generation complete: ${pptxUrl}`);

    return pptxUrl;
  } finally {
    // すべての一時ファイルをクリーンアップ
    for (const tempFile of tempFilesToDelete) {
      await safeTempFileDelete(tempFile, "SlideGenerator");
    }
  }
}
