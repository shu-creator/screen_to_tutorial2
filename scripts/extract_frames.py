#!/usr/bin/env python3
"""
動画からキーフレームを抽出するスクリプト
フレーム間差分検知により、画面が大きく変化した箇所を自動検出します
"""

import cv2
import numpy as np
import json
import sys
import os
from typing import List, Dict, Tuple

def calculate_frame_difference(frame1: np.ndarray, frame2: np.ndarray) -> float:
    """
    2つのフレーム間の差分スコアを計算
    
    Args:
        frame1: 前のフレーム
        frame2: 現在のフレーム
    
    Returns:
        差分スコア（0-100の範囲、大きいほど変化が大きい）
    """
    # グレースケールに変換
    gray1 = cv2.cvtColor(frame1, cv2.COLOR_BGR2GRAY)
    gray2 = cv2.cvtColor(frame2, cv2.COLOR_BGR2GRAY)
    
    # フレーム差分を計算
    diff = cv2.absdiff(gray1, gray2)
    
    # 差分の平均値を計算（0-255）
    mean_diff = np.mean(diff)
    
    # 0-100のスケールに正規化
    score = (mean_diff / 255.0) * 100.0
    
    return score

def extract_key_frames(
    video_path: str,
    output_dir: str,
    threshold: float = 5.0,
    min_interval: int = 30,
    max_frames: int = 100
) -> List[Dict]:
    """
    動画からキーフレームを抽出
    
    Args:
        video_path: 入力動画ファイルのパス
        output_dir: 出力ディレクトリ
        threshold: 差分検知の閾値（デフォルト: 5.0）
        min_interval: 最小フレーム間隔（デフォルト: 30フレーム）
        max_frames: 最大抽出フレーム数（デフォルト: 100）
    
    Returns:
        抽出されたフレーム情報のリスト
    """
    # 出力ディレクトリを作成
    os.makedirs(output_dir, exist_ok=True)
    
    # 動画を開く
    cap = cv2.VideoCapture(video_path)
    
    if not cap.isOpened():
        raise Exception(f"動画ファイルを開けません: {video_path}")
    
    # 動画情報を取得
    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    
    print(f"動画情報: FPS={fps}, 総フレーム数={total_frames}", file=sys.stderr)
    
    extracted_frames = []
    prev_frame = None
    frame_count = 0
    last_extracted_frame = -min_interval
    
    while True:
        ret, frame = cap.read()
        
        if not ret:
            break
        
        # 最初のフレームは必ず保存
        if frame_count == 0:
            output_path = os.path.join(output_dir, f"frame_{frame_count:06d}.jpg")
            cv2.imwrite(output_path, frame)
            
            extracted_frames.append({
                "frame_number": frame_count,
                "timestamp": int((frame_count / fps) * 1000),  # ミリ秒
                "filename": os.path.basename(output_path),
                "diff_score": 0
            })
            
            prev_frame = frame.copy()
            last_extracted_frame = frame_count
            frame_count += 1
            continue
        
        # 最小間隔チェック
        if frame_count - last_extracted_frame < min_interval:
            frame_count += 1
            continue
        
        # 差分スコアを計算
        diff_score = calculate_frame_difference(prev_frame, frame)
        
        # 閾値を超えた場合、キーフレームとして保存
        if diff_score >= threshold:
            output_path = os.path.join(output_dir, f"frame_{frame_count:06d}.jpg")
            cv2.imwrite(output_path, frame)
            
            extracted_frames.append({
                "frame_number": frame_count,
                "timestamp": int((frame_count / fps) * 1000),
                "filename": os.path.basename(output_path),
                "diff_score": int(diff_score)
            })
            
            last_extracted_frame = frame_count
            prev_frame = frame.copy()
            
            # 最大フレーム数に達したら終了
            if len(extracted_frames) >= max_frames:
                print(f"最大フレーム数 ({max_frames}) に達しました", file=sys.stderr)
                break
        
        frame_count += 1
    
    cap.release()
    
    print(f"抽出完了: {len(extracted_frames)} フレーム", file=sys.stderr)
    
    return extracted_frames

def main():
    if len(sys.argv) < 3:
        print("使用方法: python extract_frames.py <video_path> <output_dir> [threshold] [min_interval] [max_frames]")
        sys.exit(1)
    
    video_path = sys.argv[1]
    output_dir = sys.argv[2]
    threshold = float(sys.argv[3]) if len(sys.argv) > 3 else 5.0
    min_interval = int(sys.argv[4]) if len(sys.argv) > 4 else 30
    max_frames = int(sys.argv[5]) if len(sys.argv) > 5 else 100
    
    try:
        frames = extract_key_frames(
            video_path,
            output_dir,
            threshold=threshold,
            min_interval=min_interval,
            max_frames=max_frames
        )
        
        # JSON形式で出力
        print(json.dumps(frames, ensure_ascii=False, indent=2))
        
    except Exception as e:
        print(f"エラー: {str(e)}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
