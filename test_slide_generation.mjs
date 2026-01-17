import { generateSlides } from "./server/slideGenerator.ts";

async function testSlideGeneration() {
  console.log("スライド生成のテストを開始します...\n");

  // テストステップデータ
  const steps = [
    {
      id: 1,
      title: "テストパターン表示",
      operation: "映像信号の確認と調整",
      description: "これは映像機器や放送局で使用されるテストパターン（カラーバー）です。色、明るさ、コントラストなどが正しく表示されているかを確認するために使われます。",
      narration: "これはカラーバーと呼ばれるテストパターンです。映像信号が正しく出力されているかを確認できます。",
      imageUrl: "/home/ubuntu/test_frames/frame_000000.jpg",
      sortOrder: 0,
    },
  ];

  const projectTitle = "テストプロジェクト - 動画チュートリアル";

  try {
    console.log("ステップ情報:");
    console.log(JSON.stringify(steps, null, 2));
    console.log("\nスライドを生成中...");

    const slideUrl = await generateSlides(steps, projectTitle);

    console.log("\n✅ スライド生成が成功しました！");
    console.log(`生成されたスライドURL: ${slideUrl}`);

    return slideUrl;
  } catch (error) {
    console.error("\n❌ エラーが発生しました:");
    console.error(error);
    process.exit(1);
  }
}

testSlideGeneration();
