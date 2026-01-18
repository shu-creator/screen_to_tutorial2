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
        const response = await fetch(frame.imageUrl);
        const imageBuffer = Buffer.from(await response.arrayBuffer());
        const tempImagePath = createTempFilePath(`frame_${frame.id}`, ".jpg");
        await fs.writeFile(tempImagePath, imageBuffer);

        // スライドに画像を追加
        slide.addImage({
          path: tempImagePath,
          x: 0.5,
          y: 1.8,
          w: 9.0,
          h: 5.0,
          sizing: { type: "contain", w: 9.0, h: 5.0 },
        });

        // 一時ファイルを削除
        await safeTempFileDelete(tempImagePath, "SlideGenerator");
      } catch (error) {
        console.error(`[SlideGenerator] Error adding image for frame ${frame.id}:`, error);
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
  await pptx.writeFile({ fileName: tempPptxPath });

  // S3にアップロード
  const pptxBuffer = await fs.readFile(tempPptxPath);
  const fileKey = `projects/${projectId}/slides/${nanoid()}.pptx`;
  const { url: pptxUrl } = await storagePut(
    fileKey,
    pptxBuffer,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  );

  // 一時ファイルを削除
  await safeTempFileDelete(tempPptxPath, "SlideGenerator");

  console.log(`[SlideGenerator] Slide generation complete: ${pptxUrl}`);

  return pptxUrl;
}
