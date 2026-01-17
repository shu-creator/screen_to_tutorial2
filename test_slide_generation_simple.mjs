import PptxGenJS from "pptxgenjs";
import { readFileSync } from "fs";
import { writeFileSync } from "fs";

async function testSlideGeneration() {
  console.log("スライド生成の簡易テストを開始します...\n");

  try {
    // PowerPointプレゼンテーションを作成
    const pptx = new PptxGenJS();

    // プレゼンテーション設定
    pptx.author = "TutorialGen";
    pptx.company = "TutorialGen";
    pptx.title = "テストプロジェクト - 動画チュートリアル";
    pptx.subject = "動画から自動生成されたチュートリアル";

    // タイトルスライド
    const titleSlide = pptx.addSlide();
    titleSlide.background = { color: "4472C4" };
    
    titleSlide.addText("テストプロジェクト", {
      x: 0.5,
      y: 2.0,
      w: "90%",
      h: 1.5,
      fontSize: 44,
      bold: true,
      color: "FFFFFF",
      align: "center",
    });

    titleSlide.addText("動画チュートリアル", {
      x: 0.5,
      y: 3.5,
      w: "90%",
      h: 0.8,
      fontSize: 24,
      color: "FFFFFF",
      align: "center",
    });

    // コンテンツスライド
    const contentSlide = pptx.addSlide();
    contentSlide.background = { color: "FFFFFF" };

    // ステップタイトル
    contentSlide.addText("ステップ 1: テストパターン表示", {
      x: 0.5,
      y: 0.5,
      w: "90%",
      h: 0.6,
      fontSize: 32,
      bold: true,
      color: "4472C4",
    });

    // 画像を追加（Base64エンコード）
    const imagePath = "/home/ubuntu/test_frames/frame_000000.jpg";
    const imageBuffer = readFileSync(imagePath);
    const base64Image = imageBuffer.toString("base64");
    
    contentSlide.addImage({
      data: `data:image/jpeg;base64,${base64Image}`,
      x: 1.0,
      y: 1.5,
      w: 8.0,
      h: 4.5,
    });

    // 説明テキスト
    const description = "これは映像機器や放送局で使用されるテストパターン（カラーバー）です。色、明るさ、コントラストなどが正しく表示されているかを確認するために使われます。";
    
    contentSlide.addText(description, {
      x: 0.5,
      y: 6.2,
      w: "90%",
      h: 1.0,
      fontSize: 14,
      color: "333333",
      valign: "top",
    });

    // スピーカーノート
    contentSlide.addNotes("これはカラーバーと呼ばれるテストパターンです。映像信号が正しく出力されているかを確認できます。");

    // ファイルに保存
    const outputPath = "/home/ubuntu/test_presentation.pptx";
    await pptx.writeFile({ fileName: outputPath });

    console.log("\n✅ スライド生成が成功しました！");
    console.log(`生成されたスライド: ${outputPath}`);

    return outputPath;
  } catch (error) {
    console.error("\n❌ エラーが発生しました:");
    console.error(error);
    process.exit(1);
  }
}

testSlideGeneration();
