#!/usr/bin/env python3
"""
ローカルOCRエンジンサーバー（Phase 1）

stdin/stdout のJSONLプロトコルで複数画像のOCRを処理する。
プロセス起動コスト（モデルロード）を画像ごとに払わないための常駐型。

エンジン選択（起動時に自動）:
  1. PaddleOCR（lang=japan）… 推奨。モデル未取得の環境では利用不可
  2. Tesseract（-l jpn）   … フォールバック
  どちらも使えない場合は ready:false を返して終了し、
  呼び出し側（server/_core/ocrEngine.ts）がLLM-OCRへフォールバックする。

プロトコル:
  起動時:  {"ready": true, "engine": "paddle"|"tesseract"} | {"ready": false, "error": "..."}
  요청:    {"id": "...", "image_path": "/abs/path.jpg"}
  応答:    {"id": "...", "lines": [{"text": "...", "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.05, "score": 0.98}], "error": null}
  座標は 0..1 の正規化座標（左上原点）。
"""

import json
import os
import subprocess
import sys
import tempfile


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def decode_process_output(value):
    return value.decode("utf-8", errors="replace")


class PaddleEngine:
    name = "paddle"

    def __init__(self):
        from paddleocr import PaddleOCR  # noqa: PLC0415

        self.ocr = PaddleOCR(
            lang=os.environ.get("OCR_PADDLE_LANG", "japan"),
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
        )
        # モデルロード確認のため小さな画像で1回実行する
        from PIL import Image  # noqa: PLC0415

        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
            Image.new("RGB", (64, 32), "white").save(f.name)
            probe = f.name
        try:
            self.ocr.predict(probe)
        finally:
            os.unlink(probe)

    def recognize(self, image_path):
        from PIL import Image  # noqa: PLC0415

        with Image.open(image_path) as img:
            width, height = img.size

        result = self.ocr.predict(image_path)
        lines = []
        if result:
            r = result[0]
            texts = r.get("rec_texts", [])
            scores = r.get("rec_scores", [])
            boxes = r.get("rec_boxes", [])
            for i, text in enumerate(texts):
                text = (text or "").strip()
                if not text:
                    continue
                score = float(scores[i]) if i < len(scores) else 0.0
                if i < len(boxes):
                    x0, y0, x1, y1 = [float(v) for v in boxes[i]]
                else:
                    x0 = y0 = 0.0
                    x1, y1 = float(width), float(height)
                lines.append(
                    {
                        "text": text,
                        "x": max(0.0, x0 / width),
                        "y": max(0.0, y0 / height),
                        "w": max(0.0, (x1 - x0) / width),
                        "h": max(0.0, (y1 - y0) / height),
                        "score": round(score, 4),
                    }
                )
        return lines


class TesseractEngine:
    name = "tesseract"

    def __init__(self):
        lang_check = subprocess.run(
            ["tesseract", "--list-langs"], capture_output=True, timeout=30
        )
        langs = decode_process_output(lang_check.stdout)
        self.lang = os.environ.get("OCR_TESSERACT_LANG", "jpn")
        if self.lang not in langs:
            raise RuntimeError(f"tesseract言語データがありません: {self.lang}")

    def recognize(self, image_path):
        from PIL import Image  # noqa: PLC0415

        with Image.open(image_path) as img:
            width, height = img.size

        proc = subprocess.run(
            ["tesseract", image_path, "-", "-l", self.lang, "tsv"],
            capture_output=True,
            timeout=120,
        )
        stdout = decode_process_output(proc.stdout)
        stderr = decode_process_output(proc.stderr)
        if proc.returncode != 0:
            raise RuntimeError(f"tesseract失敗: {stderr[:200]}")

        # TSVの単語を (block, par, line) 単位で行にグループ化する
        groups = {}
        header = None
        for row in stdout.splitlines():
            cols = row.split("\t")
            if header is None:
                header = cols
                continue
            if len(cols) != len(header):
                continue
            rec = dict(zip(header, cols))
            text = (rec.get("text") or "").strip()
            conf = float(rec.get("conf", "-1"))
            if not text or conf < 0:
                continue
            key = (rec["block_num"], rec["par_num"], rec["line_num"])
            entry = groups.setdefault(
                key, {"words": [], "confs": [], "x0": 1e9, "y0": 1e9, "x1": 0, "y1": 0}
            )
            left, top = int(rec["left"]), int(rec["top"])
            w, h = int(rec["width"]), int(rec["height"])
            entry["words"].append(text)
            entry["confs"].append(conf)
            entry["x0"] = min(entry["x0"], left)
            entry["y0"] = min(entry["y0"], top)
            entry["x1"] = max(entry["x1"], left + w)
            entry["y1"] = max(entry["y1"], top + h)

        lines = []
        for entry in groups.values():
            # CJK文字を含む行は単語間スペースを除去して連結（tesseractは
            # 日本語の文字間に擬似的な単語境界を入れるため）。純英数行はスペース維持
            has_cjk = any(
                0x3000 <= ord(c) <= 0x9FFF or 0xFF00 <= ord(c) <= 0xFFEF
                for word in entry["words"]
                for c in word
            )
            text = ("" if has_cjk else " ").join(entry["words"])
            lines.append(
                {
                    "text": text,
                    "x": entry["x0"] / width,
                    "y": entry["y0"] / height,
                    "w": (entry["x1"] - entry["x0"]) / width,
                    "h": (entry["y1"] - entry["y0"]) / height,
                    "score": round(sum(entry["confs"]) / len(entry["confs"]) / 100.0, 4),
                }
            )
        lines.sort(key=lambda l: (l["y"], l["x"]))
        return lines


def init_engine():
    preferred = os.environ.get("OCR_ENGINE_PREFERENCE", "paddle,tesseract").split(",")
    errors = []
    for name in [p.strip() for p in preferred if p.strip()]:
        try:
            if name == "paddle":
                return PaddleEngine()
            if name == "tesseract":
                return TesseractEngine()
            errors.append(f"{name}: 未知のエンジン")
        except Exception as e:  # noqa: BLE001
            errors.append(f"{name}: {type(e).__name__}: {str(e)[:200]}")
    raise RuntimeError("; ".join(errors))


def main():
    try:
        engine = init_engine()
    except Exception as e:  # noqa: BLE001
        emit({"ready": False, "error": str(e)[:500]})
        return 1

    emit({"ready": True, "engine": engine.name})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            emit({"id": None, "lines": [], "error": "invalid json"})
            continue

        request_id = request.get("id")
        image_path = request.get("image_path", "")
        try:
            if not os.path.isfile(image_path):
                raise FileNotFoundError(f"画像がありません: {image_path}")
            lines = engine.recognize(image_path)
            emit({"id": request_id, "lines": lines, "error": None})
        except Exception as e:  # noqa: BLE001
            emit({"id": request_id, "lines": [], "error": str(e)[:300]})

    return 0


if __name__ == "__main__":
    sys.exit(main())
