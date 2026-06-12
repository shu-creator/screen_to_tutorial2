/**
 * ローカルOCRエンジンアダプター（Phase 1）
 *
 * scripts/ocr_server.py を常駐子プロセスとして起動し、JSONLプロトコルで
 * 複数画像を処理する。エンジン（PaddleOCR / Tesseract）が利用できない
 * 環境では isAvailable() が false になり、呼び出し側がLLM-OCRへ
 * フォールバックする（server/_core/ocr.ts の extractFrameOcrUnified）。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import path from "path";
import readline from "readline";
import { createLogger } from "./logger";

const logger = createLogger("OCREngine");

export interface EngineOcrLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

interface EngineResponse {
  id: string | null;
  lines?: EngineOcrLine[];
  error?: string | null;
  ready?: boolean;
  engine?: string;
}

const REQUEST_TIMEOUT_MS = 120_000;
const STARTUP_TIMEOUT_MS = 600_000; // 初回はモデルロードがあるため長め

export class OcrEngineClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private engineName: string | null = null;
  private startupPromise: Promise<boolean> | null = null;
  private pending = new Map<
    string,
    { resolve: (lines: EngineOcrLine[]) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private nextId = 1;

  constructor(
    private readonly scriptPath: string = path.resolve(
      process.cwd(),
      "scripts",
      "ocr_server.py",
    ),
    private readonly pythonBin: string = process.env.OCR_PYTHON_BIN ?? "python3",
  ) {}

  /** エンジンが利用可能か（初回呼び出しでプロセスを起動して判定） */
  async isAvailable(): Promise<boolean> {
    if (this.engineName) return true;
    if (!this.startupPromise) {
      this.startupPromise = this.start();
    }
    return this.startupPromise;
  }

  get engine(): string | null {
    return this.engineName;
  }

  private start(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (ok: boolean) => {
        if (!settled) {
          settled = true;
          resolve(ok);
        }
      };

      let proc: ChildProcessWithoutNullStreams;
      try {
        proc = spawn(this.pythonBin, [this.scriptPath], {
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        logger.warn("OCRエンジンの起動に失敗", {
          message: error instanceof Error ? error.message : String(error),
        });
        settle(false);
        return;
      }

      const startupTimer = setTimeout(() => {
        logger.warn("OCRエンジンの起動がタイムアウトしました");
        proc.kill("SIGTERM");
        settle(false);
      }, STARTUP_TIMEOUT_MS);

      const rl = readline.createInterface({ input: proc.stdout });
      rl.on("line", (line) => {
        let response: EngineResponse;
        try {
          response = JSON.parse(line) as EngineResponse;
        } catch {
          return;
        }

        if (response.ready !== undefined) {
          clearTimeout(startupTimer);
          if (response.ready) {
            this.proc = proc;
            this.engineName = response.engine ?? "unknown";
            logger.info(`OCRエンジン起動: ${this.engineName}`);
            settle(true);
          } else {
            logger.info(
              `ローカルOCRエンジン利用不可（LLM-OCRへフォールバック）: ${response.error ?? ""}`,
            );
            settle(false);
          }
          return;
        }

        if (response.id) {
          const waiter = this.pending.get(response.id);
          if (waiter) {
            this.pending.delete(response.id);
            clearTimeout(waiter.timer);
            if (response.error) {
              waiter.reject(new Error(response.error));
            } else {
              waiter.resolve(response.lines ?? []);
            }
          }
        }
      });

      proc.stderr.on("data", () => {
        /* モデルロードの進捗等は無視 */
      });

      proc.on("error", (error) => {
        clearTimeout(startupTimer);
        logger.warn("OCRエンジンプロセスエラー", { message: error.message });
        settle(false);
      });

      proc.on("close", () => {
        clearTimeout(startupTimer);
        this.proc = null;
        this.engineName = null;
        this.startupPromise = null;
        this.pending.forEach((waiter) => {
          clearTimeout(waiter.timer);
          waiter.reject(new Error("OCRエンジンプロセスが終了しました"));
        });
        this.pending.clear();
        settle(false);
      });
    });
  }

  /** ローカル画像ファイルのOCRを実行する */
  async recognize(imagePath: string): Promise<EngineOcrLine[]> {
    const available = await this.isAvailable();
    if (!available || !this.proc) {
      throw new Error("ローカルOCRエンジンは利用できません");
    }

    const id = `ocr-${this.nextId++}`;
    const request = `${JSON.stringify({ id, image_path: imagePath })}\n`;

    return new Promise<EngineOcrLine[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("OCRリクエストがタイムアウトしました"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.proc?.stdin.write(request, (error) => {
        if (error) {
          const waiter = this.pending.get(id);
          if (waiter) {
            this.pending.delete(id);
            clearTimeout(waiter.timer);
            waiter.reject(error);
          }
        }
      });
    });
  }

  async shutdown(): Promise<void> {
    if (this.proc) {
      this.proc.stdin.end();
      this.proc.kill("SIGTERM");
      this.proc = null;
      this.engineName = null;
      this.startupPromise = null;
    }
  }
}

/** プロセス全体で共有するシングルトン（モデルロードを1回にする） */
let sharedClient: OcrEngineClient | null = null;

export function getSharedOcrEngine(): OcrEngineClient {
  if (!sharedClient) {
    sharedClient = new OcrEngineClient();
  }
  return sharedClient;
}
