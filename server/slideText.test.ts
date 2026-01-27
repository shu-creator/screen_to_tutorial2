import { describe, it, expect } from "vitest";
import {
  truncateAtSentence,
  ensureTerminalPunctuation,
  anonymizeOnScreenStepNumbers,
  uniquifyTitles,
  fixFinalStepIfHover,
} from "./slideText";

// ---------------------------------------------------------------------------
// 1) truncateAtSentence
// ---------------------------------------------------------------------------
describe("truncateAtSentence", () => {
  it("maxChars 以内のテキストはそのまま返す", () => {
    expect(truncateAtSentence("短いテキスト。", 20)).toBe("短いテキスト。");
  });

  it("空文字列は空文字列を返す", () => {
    expect(truncateAtSentence("", 10)).toBe("");
  });

  it("句点位置で切れる（文が途中で切れない）", () => {
    const text = "最初の文。次の文。さらに長い三番目の文が続きます。";
    // maxChars=12 → "最初の文。次の文。さらに" の中で最後の「。」は index 8
    const result = truncateAtSentence(text, 12);
    expect(result).toBe("最初の文。次の文。…");
    expect(result.endsWith("…")).toBe(true);
  });

  it("半角句点 '.' でも切れる", () => {
    const text = "Hello world. This is a longer sentence that overflows.";
    const result = truncateAtSentence(text, 20);
    expect(result).toBe("Hello world.…");
  });

  it("句点が見つからない場合は文字数切り + '…'", () => {
    const text = "句点のないとても長いテキストが延々と続いていく";
    const result = truncateAtSentence(text, 10);
    expect(result).toBe("句点のないとても長…");
    expect(result.length).toBe(10); // (maxChars-1)文字 + "…"
  });

  it("ちょうど maxChars のテキストは切らない", () => {
    const text = "ぴったり10文字のテキスト";
    expect(truncateAtSentence(text, text.length)).toBe(text);
  });

  it("全角感嘆符・疑問符でも切れる", () => {
    const text = "本当ですか？それは驚きです！そしてさらに続く長い文章。";
    const result = truncateAtSentence(text, 15);
    // "本当ですか？それは驚きです！そし" → 最後の終端は index 13 の "！"
    expect(result).toBe("本当ですか？それは驚きです！…");
  });
});

// ---------------------------------------------------------------------------
// 2) ensureTerminalPunctuation
// ---------------------------------------------------------------------------
describe("ensureTerminalPunctuation", () => {
  it("空文字列は空文字列を返す", () => {
    expect(ensureTerminalPunctuation("")).toBe("");
  });

  it("末尾が句点で終わっていればそのまま", () => {
    expect(ensureTerminalPunctuation("確認する。")).toBe("確認する。");
  });

  it("末尾に句点がなければ '。' を付与する", () => {
    expect(ensureTerminalPunctuation("確認する")).toBe("確認する。");
  });

  it("末尾が '…' で終わっていればそのまま", () => {
    expect(ensureTerminalPunctuation("テキスト…")).toBe("テキスト…");
  });

  it("末尾が '！' で終わっていればそのまま", () => {
    expect(ensureTerminalPunctuation("完了！")).toBe("完了！");
  });

  it("末尾が '？' で終わっていればそのまま", () => {
    expect(ensureTerminalPunctuation("本当？")).toBe("本当？");
  });

  it("末尾の空白を無視して判定する", () => {
    expect(ensureTerminalPunctuation("確認する   ")).toBe("確認する。");
  });

  it("半角ピリオドで終わっていればそのまま", () => {
    expect(ensureTerminalPunctuation("Done.")).toBe("Done.");
  });
});

// ---------------------------------------------------------------------------
// 3) anonymizeOnScreenStepNumbers
// ---------------------------------------------------------------------------
describe("anonymizeOnScreenStepNumbers", () => {
  it("空文字列は空文字列を返す", () => {
    expect(anonymizeOnScreenStepNumbers("")).toBe("");
  });

  it("'ステップ17' が匿名化される", () => {
    const result = anonymizeOnScreenStepNumbers("ステップ17を確認する");
    expect(result).toBe("ステップ（画面上）を確認する");
    expect(result).not.toMatch(/ステップ\d/);
  });

  it("'ステップ17からステップ21' が匿名化される", () => {
    const result = anonymizeOnScreenStepNumbers(
      "ステップ17からステップ21を実行する",
    );
    expect(result).toBe("ステップ（画面上）を実行する");
    expect(result).not.toMatch(/\d/);
  });

  it("'ステップ7から10' が匿名化される", () => {
    const result = anonymizeOnScreenStepNumbers("ステップ7から10を参照");
    expect(result).toBe("ステップ（画面上）を参照");
  });

  it("'ステップ16、17、18' が匿名化される", () => {
    const result = anonymizeOnScreenStepNumbers(
      "ステップ16、17、18を参照してください",
    );
    expect(result).toBe("ステップ一覧の一部を参照してください");
  });

  it("'ステップ一覧' (数字なし) は変更しない", () => {
    const text = "ステップ一覧を確認してください";
    expect(anonymizeOnScreenStepNumbers(text)).toBe(text);
  });

  it("数字を含まない 'ステップ' は変更しない", () => {
    const text = "次のステップに進む";
    expect(anonymizeOnScreenStepNumbers(text)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// 4) uniquifyTitles
// ---------------------------------------------------------------------------
describe("uniquifyTitles", () => {
  it("重複がなければ displayTitle は元のタイトルのまま", () => {
    const steps = [
      { title: "ログイン" },
      { title: "設定変更" },
      { title: "保存" },
    ];
    const result = uniquifyTitles(steps);
    expect(result[0].displayTitle).toBe("ログイン");
    expect(result[1].displayTitle).toBe("設定変更");
    expect(result[2].displayTitle).toBe("保存");
  });

  it("同一タイトルが2回目で '（続き）' が付く", () => {
    const steps = [
      { title: "設定変更" },
      { title: "設定変更" },
    ];
    const result = uniquifyTitles(steps);
    expect(result[0].displayTitle).toBe("設定変更");
    expect(result[1].displayTitle).toBe("設定変更（続き）");
  });

  it("同一タイトルが3回以上で '（続きN）' が付く", () => {
    const steps = [
      { title: "入力" },
      { title: "入力" },
      { title: "入力" },
      { title: "入力" },
    ];
    const result = uniquifyTitles(steps);
    expect(result[0].displayTitle).toBe("入力");
    expect(result[1].displayTitle).toBe("入力（続き）");
    expect(result[2].displayTitle).toBe("入力（続き2）");
    expect(result[3].displayTitle).toBe("入力（続き3）");
  });

  it("元のプロパティが保持される", () => {
    const steps = [{ title: "A", sortOrder: 0, extra: 42 }];
    const result = uniquifyTitles(steps);
    expect(result[0].sortOrder).toBe(0);
    expect((result[0] as any).extra).toBe(42);
    expect(result[0].displayTitle).toBe("A");
  });

  it("空配列は空配列を返す", () => {
    expect(uniquifyTitles([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5) fixFinalStepIfHover
// ---------------------------------------------------------------------------
describe("fixFinalStepIfHover", () => {
  it("カーソル操作のみの場合は補正される", () => {
    const result = fixFinalStepIfHover(
      "カーソルを合わせる",
      "要素にカーソルを合わせます",
    );
    expect(result.modified).toBe(true);
    expect(result.operation).toContain("確認する");
    expect(result.description).toContain("意図どおりか確認");
  });

  it("ホバー操作のみの場合は補正される", () => {
    const result = fixFinalStepIfHover(
      "ボタンにホバーする",
      "ボタン上にマウスを置く",
    );
    expect(result.modified).toBe(true);
  });

  it("クリックを含む場合は補正されない", () => {
    const result = fixFinalStepIfHover(
      "カーソルを合わせてクリックする",
      "ボタンをクリック",
    );
    expect(result.modified).toBe(false);
    expect(result.operation).toBe("カーソルを合わせてクリックする");
  });

  it("カーソル/ホバーを含まない通常操作は補正されない", () => {
    const result = fixFinalStepIfHover(
      "保存ボタンを押す",
      "変更を保存します",
    );
    expect(result.modified).toBe(false);
    expect(result.operation).toBe("保存ボタンを押す");
  });

  it("選択操作を含む場合は補正されない", () => {
    const result = fixFinalStepIfHover(
      "カーソルで選択する",
      "テキストを選択",
    );
    expect(result.modified).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 統合テスト: パイプライン適用順序
// ---------------------------------------------------------------------------
describe("テキスト整形パイプライン", () => {
  it("ensureTerminalPunctuation → truncateAtSentence の順で操作テキストを整形", () => {
    const raw = "ボタンをクリックする";
    const withPunct = ensureTerminalPunctuation(raw); // "ボタンをクリックする。"
    const result = truncateAtSentence(withPunct, 60);
    expect(result).toBe("ボタンをクリックする。");
  });

  it("anonymize → ensureTerminalPunctuation → truncateAtSentence の順で詳細テキストを整形", () => {
    const raw =
      "ステップ17からステップ21を確認し、設定を変更する";
    const anonymized = anonymizeOnScreenStepNumbers(raw);
    expect(anonymized).not.toMatch(/\d/);
    const withPunct = ensureTerminalPunctuation(anonymized);
    expect(withPunct.endsWith("。")).toBe(true);
    const result = truncateAtSentence(withPunct, 120);
    expect(result.endsWith("。")).toBe(true);
  });
});
