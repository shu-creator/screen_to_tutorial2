#!/usr/bin/env python3
"""
合成評価データセット生成スクリプト（Phase 0）

UI風の画面遷移を Pillow で描画し、ffmpeg で動画化する。
タイムライン定義から ground_truth.json を同時生成するため、
動画と正解の整合が構造的に保証される。

実録画が用意できない環境でのセグメンテーション/OCR検証用。
LLM品質（G2/G3の意味的判断）の最終検証は実録画で行うこと
（docs/plans/phase-0-eval-harness.md 参照）。

使用方法:
    python3 eval/generate_dataset.py [--case <case-id>] [--outdir eval/dataset]

依存: pillow, ffmpeg, IPAゴシック（/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf）
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

WIDTH, HEIGHT = 1280, 720
FPS = 10
FONT_CANDIDATES = [
    "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]

GENERATOR_VERSION = "1.0"


def load_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


FONT_L = load_font(40)
FONT_M = load_font(28)
FONT_S = load_font(20)


def new_screen(bg="#f4f5f7"):
    img = Image.new("RGB", (WIDTH, HEIGHT), bg)
    draw = ImageDraw.Draw(img, "RGBA")
    # ヘッダーバー
    draw.rectangle([0, 0, WIDTH, 56], fill="#2c3e50")
    draw.text((24, 12), "サンプル業務アプリ", font=FONT_M, fill="white")
    return img, draw


def button(draw, x, y, w, h, label, fill="#3478f6", text_fill="white"):
    draw.rounded_rectangle([x, y, x + w, y + h], radius=8, fill=fill)
    bbox = draw.textbbox((0, 0), label, font=FONT_M)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text((x + (w - tw) / 2, y + (h - th) / 2 - bbox[1]), label, font=FONT_M, fill=text_fill)
    return (x, y, w, h)


def text_field(draw, x, y, w, label, value=""):
    draw.text((x, y), label, font=FONT_S, fill="#444444")
    draw.rectangle([x, y + 30, x + w, y + 78], fill="white", outline="#bbbbbb", width=2)
    if value:
        draw.text((x + 12, y + 42), value, font=FONT_M, fill="#222222")


def click_marker(draw, cx, cy):
    """クリック位置の視覚インジケーター（実録画のカーソルハイライト相当）"""
    draw.ellipse([cx - 22, cy - 22, cx + 22, cy + 22], outline=(255, 160, 0, 230), width=5)
    draw.ellipse([cx - 6, cy - 6, cx + 6, cy + 6], fill=(255, 160, 0, 230))


class Timeline:
    """フレーム列とground truthを同時に構築する"""

    def __init__(self):
        self.frames = []  # PIL Image のリスト
        self.steps = []   # ground truth steps

    @property
    def now_ms(self):
        return int(len(self.frames) * 1000 / FPS)

    def hold(self, img, duration_ms):
        count = max(1, round(duration_ms * FPS / 1000))
        for _ in range(count):
            self.frames.append(img)

    def fade(self, img_from, img_to, duration_ms):
        count = max(2, round(duration_ms * FPS / 1000))
        for i in range(count):
            alpha = (i + 1) / count
            self.frames.append(Image.blend(img_from, img_to, alpha))

    def add_step(self, t_start, t_end, title, ui_labels=None, non_step=False):
        step = {
            "t_start": int(t_start),
            "t_end": int(t_end),
            "title": title,
            "ui_labels": ui_labels or [],
        }
        if non_step:
            step["non_step"] = True
        self.steps.append(step)


# ---------------------------------------------------------------------------
# ケース定義
# ---------------------------------------------------------------------------

def screen_login(username="", clicked=False):
    img, draw = new_screen()
    draw.text((520, 120), "ログイン", font=FONT_L, fill="#222222")
    text_field(draw, 440, 220, 400, "ユーザー名", username)
    text_field(draw, 440, 330, 400, "パスワード", "●●●●●●" if username else "")
    rect = button(draw, 440, 460, 400, 56, "ログイン")
    if clicked:
        click_marker(draw, rect[0] + rect[2] / 2, rect[1] + rect[3] / 2)
    return img


def screen_dashboard(scroll_px=0, clicked_settings=False):
    img, draw = new_screen()
    draw.text((60, 90 - scroll_px), "ダッシュボード", font=FONT_L, fill="#222222")
    for i in range(8):
        y = 170 + i * 90 - scroll_px
        if -80 < y < HEIGHT:
            draw.rectangle([60, y, 900, y + 70], fill="white", outline="#dddddd", width=2)
            draw.text((80, y + 20), f"案件 {i + 1}: 月次レポート確認", font=FONT_S, fill="#333333")
    rect = button(draw, 1000, 100, 200, 52, "設定", fill="#6b7280")
    if clicked_settings:
        click_marker(draw, rect[0] + rect[2] / 2, rect[1] + rect[3] / 2)
    return img


def screen_settings():
    img, draw = new_screen()
    draw.text((60, 100), "設定", font=FONT_L, fill="#222222")
    draw.text((60, 180), "通知: 有効", font=FONT_M, fill="#333333")
    draw.text((60, 230), "テーマ: ライト", font=FONT_M, fill="#333333")
    button(draw, 60, 320, 220, 52, "変更を保存")
    return img


def case_login_click():
    """画面遷移+スクロール（non_step）: 基本のクリック操作ケース"""
    tl = Timeline()

    # Step 1: ログイン画面でログインをクリック → ダッシュボード
    s1_start = tl.now_ms
    tl.hold(screen_login("yamada"), 2500)
    tl.hold(screen_login("yamada", clicked=True), 400)
    tl.fade(screen_login("yamada", clicked=True), screen_dashboard(), 300)
    s1_end = tl.now_ms
    tl.add_step(s1_start, s1_end, "ログインする", ["ログイン", "ユーザー名"])

    tl.hold(screen_dashboard(), 1500)

    # 非ステップ: スクロール
    scroll_start = tl.now_ms
    for px in range(0, 220, 11):  # 2秒かけてスクロール
        tl.hold(screen_dashboard(scroll_px=px), 1000 / FPS)
    scroll_end = tl.now_ms
    tl.add_step(scroll_start, scroll_end, "スクロール", non_step=True)

    tl.hold(screen_dashboard(scroll_px=220), 1500)

    # Step 2: 設定をクリック → 設定画面
    s2_start = tl.now_ms
    tl.hold(screen_dashboard(scroll_px=220, clicked_settings=True), 400)
    tl.fade(screen_dashboard(scroll_px=220, clicked_settings=True), screen_settings(), 300)
    s2_end = tl.now_ms
    tl.add_step(s2_start, s2_end, "設定画面を開く", ["設定"])

    tl.hold(screen_settings(), 2500)
    return tl, "クリック2回+スクロール(非ステップ)を含む基本ケース"


def screen_form(name="", email="", saved=False, clicked_save=False):
    img, draw = new_screen()
    draw.text((60, 90), "顧客登録", font=FONT_L, fill="#222222")
    text_field(draw, 60, 180, 480, "氏名", name)
    text_field(draw, 60, 300, 480, "メールアドレス", email)
    rect = button(draw, 60, 440, 220, 52, "保存")
    if clicked_save:
        click_marker(draw, rect[0] + rect[2] / 2, rect[1] + rect[3] / 2)
    if saved:
        draw.rectangle([380, 250, 900, 420], fill="white", outline="#888888", width=3)
        draw.text((420, 280), "登録が完了しました", font=FONT_M, fill="#1a7f37")
        button(draw, 560, 340, 140, 48, "OK", fill="#1a7f37")
    return img


def case_form_typing():
    """1文字ずつのタイピング: coalescing検証ケース"""
    tl = Timeline()
    tl.hold(screen_form(), 2000)

    # Step 1: 氏名を入力（1文字ずつ = 連続小変化）
    s1_start = tl.now_ms
    name = "山田太郎"
    for i in range(1, len(name) + 1):
        tl.hold(screen_form(name=name[:i]), 350)
    s1_end = tl.now_ms
    tl.add_step(s1_start, s1_end, "氏名を入力する", ["氏名"])

    tl.hold(screen_form(name=name), 1200)

    # Step 2: メールアドレスを入力
    s2_start = tl.now_ms
    email = "yamada@example.com"
    for i in range(2, len(email) + 1, 2):  # 2文字ずつ
        tl.hold(screen_form(name=name, email=email[:i]), 250)
    s2_end = tl.now_ms
    tl.add_step(s2_start, s2_end, "メールアドレスを入力する", ["メールアドレス"])

    tl.hold(screen_form(name=name, email=email), 1200)

    # Step 3: 保存をクリック → 完了ダイアログ
    s3_start = tl.now_ms
    tl.hold(screen_form(name=name, email=email, clicked_save=True), 400)
    tl.fade(
        screen_form(name=name, email=email, clicked_save=True),
        screen_form(name=name, email=email, saved=True),
        200,
    )
    s3_end = tl.now_ms
    tl.add_step(s3_start, s3_end, "保存する", ["保存"])

    tl.hold(screen_form(name=name, email=email, saved=True), 2000)
    return tl, "1文字ずつのタイピング入力（coalescing検証）"


def screen_list(modal_alpha=0.0, clicked_delete=False, clicked_ok=False, deleted=False):
    img, draw = new_screen()
    draw.text((60, 90), "ファイル一覧", font=FONT_L, fill="#222222")
    rows = ["報告書.docx", "予算案.xlsx"] if deleted else ["報告書.docx", "予算案.xlsx", "旧データ.csv"]
    for i, row_name in enumerate(rows):
        y = 170 + i * 80
        draw.rectangle([60, y, 800, y + 60], fill="white", outline="#dddddd", width=2)
        draw.text((80, y + 15), row_name, font=FONT_M, fill="#333333")
    rect = button(draw, 860, 170, 160, 52, "削除", fill="#d33")
    if clicked_delete:
        click_marker(draw, rect[0] + rect[2] / 2, rect[1] + rect[3] / 2)

    if modal_alpha > 0:
        overlay = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
        odraw = ImageDraw.Draw(overlay)
        odraw.rectangle([0, 0, WIDTH, HEIGHT], fill=(0, 0, 0, int(110 * modal_alpha)))
        odraw.rectangle([340, 220, 940, 480], fill=(255, 255, 255, int(255 * modal_alpha)))
        if modal_alpha > 0.55:  # テキストはほぼ不透明になってから
            odraw.text((380, 260), "「旧データ.csv」を削除しますか？", font=FONT_M, fill=(34, 34, 34, 255))
            odraw.rounded_rectangle([520, 380, 660, 432], radius=8, fill=(211, 51, 51, 255))
            odraw.text((570, 392), "OK", font=FONT_M, fill=(255, 255, 255, 255))
            if clicked_ok:
                click_marker(odraw, 590, 406)
        img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
    return img


def case_modal_fade():
    """モーダルのフェードイン/アウト: 遷移途中フレーム選択の検証ケース"""
    tl = Timeline()
    tl.hold(screen_list(), 2200)

    # Step 1: 削除をクリック → 確認モーダルがフェードイン(0.8s)
    s1_start = tl.now_ms
    tl.hold(screen_list(clicked_delete=True), 400)
    for i in range(1, 9):  # 0.8sかけてフェードイン
        tl.hold(screen_list(modal_alpha=i / 8), 100)
    s1_end = tl.now_ms
    tl.add_step(s1_start, s1_end, "削除を実行する", ["削除"])

    tl.hold(screen_list(modal_alpha=1.0), 1800)

    # Step 2: OKをクリック → モーダルフェードアウト+行削除
    s2_start = tl.now_ms
    tl.hold(screen_list(modal_alpha=1.0, clicked_ok=True), 400)
    for i in range(7, -1, -1):  # フェードアウト
        tl.hold(screen_list(modal_alpha=i / 8, deleted=True), 100)
    s2_end = tl.now_ms
    tl.add_step(s2_start, s2_end, "削除を確定する", ["OK"])

    tl.hold(screen_list(deleted=True), 2200)
    return tl, "モーダルのフェードイン/アウト遷移（遷移途中フレームの検証）"


CASES = {
    "synth-login-click-01": case_login_click,
    "synth-form-typing-01": case_form_typing,
    "synth-modal-fade-01": case_modal_fade,
}


# ---------------------------------------------------------------------------
# エンコードと出力
# ---------------------------------------------------------------------------

def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def generate_case(case_id, outdir):
    build = CASES[case_id]
    tl, description = build()

    case_dir = os.path.join(outdir, case_id)
    os.makedirs(case_dir, exist_ok=True)
    video_path = os.path.join(case_dir, "video.mp4")

    tmpdir = tempfile.mkdtemp(prefix=f"synth_{case_id}_")
    try:
        for i, frame in enumerate(tl.frames):
            frame.save(os.path.join(tmpdir, f"frame_{i:05d}.png"))
        subprocess.run(
            [
                "ffmpeg", "-y", "-framerate", str(FPS),
                "-i", os.path.join(tmpdir, "frame_%05d.png"),
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20",
                video_path,
            ],
            check=True,
            capture_output=True,
        )
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    duration_ms = int(len(tl.frames) * 1000 / FPS)
    ground_truth = {
        "version": 1,
        "case_id": case_id,
        "steps": sorted(tl.steps, key=lambda s: s["t_start"]),
    }
    with open(os.path.join(case_dir, "ground_truth.json"), "w", encoding="utf-8") as f:
        json.dump(ground_truth, f, ensure_ascii=False, indent=2)
        f.write("\n")

    meta = {
        "case_id": case_id,
        "description": description,
        "synthetic": True,
        "generator": f"eval/generate_dataset.py v{GENERATOR_VERSION}",
        "regenerate_command": f"python3 eval/generate_dataset.py --case {case_id}",
        "video_sha256": sha256_file(video_path),
        "duration_ms": duration_ms,
        "fps": FPS,
        "resolution": f"{WIDTH}x{HEIGHT}",
        "has_narration": False,
    }
    with open(os.path.join(case_dir, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"[OK] {case_id}: {duration_ms}ms, {len(tl.steps)} GT steps -> {video_path}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", choices=sorted(CASES.keys()), help="生成するケース（省略時は全件）")
    parser.add_argument("--outdir", default="eval/dataset")
    args = parser.parse_args()

    case_ids = [args.case] if args.case else sorted(CASES.keys())
    for case_id in case_ids:
        generate_case(case_id, args.outdir)


if __name__ == "__main__":
    sys.exit(main())
