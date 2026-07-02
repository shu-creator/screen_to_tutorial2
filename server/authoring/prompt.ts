import type { Overview } from "../stepsArtifact";
import type { AuthoringChunk } from "./digest";

export type AuthoringTextContent = { type: "text"; text: string };
export type AuthoringImageContent = {
  type: "image_url";
  image_url: { url: string; detail: "high" | "low" | "auto" };
};
export type AuthoringMessageContent =
  | AuthoringTextContent
  | AuthoringImageContent;

export const SYSTEM_PROMPT = `あなたは業務画面チュートリアルの執筆者です。操作録画から抽出された「操作セグメント」の証拠（前後の画面・変化領域・OCRテキスト・発話）をもとに、手順マニュアルを執筆してください。

必ず守る制約:
- 各ステップの source_segment_ids には根拠となるセグメントIDを必ず入れる（時系列順・重複なし）
- 連続した同種の操作（例: 複数フィールドへの入力）は1ステップに統合してよい
- visibleなクリック・タブ切替・生成開始・ダウンロード・確認完了は、後続画面に結果がまとまって表示されても原則として破棄しない
- 異なる目的の操作（例: タブを開く→生成ボタンを押す→完了を確認する）は1ステップに統合しない
- スクロールのみ・ロード待ち・無意味なカーソル移動のセグメントは discarded_segments に入れて破棄する
- activity=waiting のセグメント（進捗バー・スピナー・処理待ち）は steps に使わず必ず discarded_segments に割り当てる
- 1つのstepの source_segment_ids は原則1〜2個。3個以上まとめるのは同一操作の連続（タイピング等）に限る
- source_segment_ids は操作そのものが起きた区間を選ぶ。クリック後の「処理中」「生成中」「完了待ち」など状態変化だけの区間を、ボタンを押す操作の根拠にしない
- 「作成」「生成」「ダウンロード」などのクリック操作では、ボタン名が見えている操作前後の区間を根拠にし、後続の待機・進捗・結果確認セグメントは別ステップまたは discarded_segments に分ける
- 「生成されたステップを確認する」など完了後の確認ステップは、待機中セグメントではなく、結果一覧・完了状態が表示された後のセグメントを根拠にする
- 完了後の確認ステップの t_start/t_end は、待機・生成中・完了待ちセグメントと重ならないようにする。結果一覧が表示される前の待機区間にかかる確認ステップは作らない
- 結果一覧や完了状態が見えるセグメントがない場合は、待機区間を discarded_segments に入れ、推測で「確認する」ステップを作らない
- UIラベル（ボタン名・項目名）は、そのstepの根拠セグメントのOCRテキストに実在するものだけを「」で引用し、cited_ui_labels にも列挙する。OCRにないラベルは推測せず、引用符なしの一般表現にする
- cited_ui_labels は「」で引用したUIラベルだけを入れる。OCR根拠が弱い場合は cited_ui_labels を空配列にし、説明文で補う
- cited_ui_labels には、そのstepでユーザーが操作する主要なボタン・タブ・項目だけを入れる。単なる状態表示・完了表示・空状態メッセージ・トースト文言（例: プレビュー、完了、ステップがありません、ステップの生成を開始しました）は、確認対象そのものではない限り cited_ui_labels に入れず、instruction/title でも「」引用しない
- 1ステップは「目的1つ・操作1つ・結果1つ」。instruction は短い命令文1文、expected_result は画面変化を1文で
- narration は全ステップ通して読み上げたとき自然につながる文体にする（「まず」「次に」「最後に」等の接続）
- title は重複させない
- すべてのセグメントを steps か discarded_segments のどちらかに必ず割り当てる`;

export function buildChunkUserContent(
  globalContext: string,
  chunk: AuthoringChunk,
  interimOverview: Overview | null
): AuthoringMessageContent[] {
  const header: string[] = [globalContext];
  if (chunk.totalChunks > 1) {
    header.push(
      `これは ${chunk.totalChunks} チャンク中 ${chunk.chunkIndex + 1} 番目のセグメント群です。`
    );
    if (interimOverview) {
      header.push(
        `ここまでの暫定overview: ${JSON.stringify(interimOverview)}。これと矛盾しないように執筆し、必要なら改善したoverviewを返してください。`
      );
    }
  }

  const content: AuthoringMessageContent[] = [
    { type: "text", text: header.join("\n") },
  ];

  for (const digest of chunk.digests) {
    content.push({ type: "text", text: digest.text });
    for (const url of digest.imageUrls) {
      content.push({ type: "image_url", image_url: { url, detail: "high" } });
    }
  }

  return content;
}
