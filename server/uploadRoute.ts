/**
 * Multipart file upload route
 * Handles video file uploads with streaming to avoid memory issues
 */
import { Router, Request, Response } from "express";
import Busboy from "busboy";
import { storagePut } from "./storage";
import * as db from "./db";
import { createLogger } from "./_core/logger";
import { validateVideoFile } from "./fileValidator";
import type { MaybeAuthenticatedRequest } from "./types";

const logger = createLogger("Upload");

// File size limits
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
const ALLOWED_MIME_TYPES = ["video/mp4", "video/quicktime", "video/x-msvideo"];

export const uploadRouter = Router();

/**
 * POST /api/upload/video
 * Multipart file upload for video files
 *
 * Form fields:
 * - title: string (required)
 * - description: string (optional)
 * - video: File (required)
 *
 * Response:
 * - projectId: number
 * - videoUrl: string
 * - videoKey: string
 */
uploadRouter.post("/video", async (req: MaybeAuthenticatedRequest, res: Response) => {
  // Check authentication
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "認証が必要です" });
    return;
  }

  const busboy = Busboy({
    headers: req.headers,
    limits: {
      fileSize: MAX_FILE_SIZE,
      files: 1, // Only one file allowed
    },
  });

  let title = "";
  let description = "";
  let fileReceived = false;
  let uploadError: string | null = null;
  let projectResult: { projectId: number; videoUrl: string; videoKey: string } | null = null;

  // Collect form fields
  busboy.on("field", (fieldname: string, value: string) => {
    if (fieldname === "title") {
      title = value;
    } else if (fieldname === "description") {
      description = value;
    }
  });

  // Handle file upload
  busboy.on("file", async (fieldname: string, file: NodeJS.ReadableStream, info: { filename: string; encoding: string; mimeType: string }) => {
    const { filename, mimeType } = info;

    if (fieldname !== "video") {
      file.resume(); // Discard unknown fields
      return;
    }

    fileReceived = true;

    // Validate MIME type
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
      uploadError = `サポートされていないファイル形式です: ${mimeType}。MP4、MOV、AVI形式のみ対応しています。`;
      file.resume();
      return;
    }

    // Collect file data with size tracking
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let sizeLimitExceeded = false;

    file.on("data", (chunk: Buffer) => {
      if (sizeLimitExceeded) {
        return; // Already exceeded, skip
      }

      totalSize += chunk.length;

      if (totalSize > MAX_FILE_SIZE) {
        sizeLimitExceeded = true;
        file.resume(); // Drain the stream
        return;
      }

      chunks.push(chunk);
    });

    file.on("limit", () => {
      sizeLimitExceeded = true;
      uploadError = `ファイルサイズが制限（${MAX_FILE_SIZE / 1024 / 1024}MB）を超えています`;
    });

    file.on("end", async () => {
      if (sizeLimitExceeded) {
        uploadError = `ファイルサイズが制限（${MAX_FILE_SIZE / 1024 / 1024}MB）を超えています`;
        return;
      }

      if (chunks.length === 0) {
        uploadError = "空のファイルです";
        return;
      }

      const fileBuffer = Buffer.concat(chunks);

      // Validate file content (magic bytes)
      const validation = validateVideoFile(fileBuffer, mimeType);
      if (!validation.valid) {
        uploadError = validation.error || "無効なファイルです";
        return;
      }

      try {
        // Upload to storage
        const videoKey = `projects/${user.id}/videos/${Date.now()}_${filename}`;
        const { url: videoUrl } = await storagePut(videoKey, fileBuffer, mimeType);

        // Create project in database
        const projectId = await db.createProject({
          userId: user.id,
          title: title || filename,
          description: description || undefined,
          videoUrl,
          videoKey,
          status: "uploading",
        });

        projectResult = { projectId, videoUrl, videoKey };
        logger.info("Video uploaded successfully", { projectId, userId: user.id, fileSize: totalSize });
      } catch (error) {
        logger.error("Upload failed", { userId: user.id }, error as Error);
        uploadError = error instanceof Error ? error.message : "アップロードに失敗しました";
      }
    });

    file.on("error", (err: Error) => {
      logger.error("File stream error", { userId: user.id }, err);
      uploadError = "ファイルの読み込み中にエラーが発生しました";
    });
  });

  busboy.on("finish", () => {
    if (uploadError) {
      res.status(400).json({ error: uploadError });
      return;
    }

    if (!fileReceived) {
      res.status(400).json({ error: "動画ファイルが見つかりません" });
      return;
    }

    if (!title) {
      res.status(400).json({ error: "タイトルは必須です" });
      return;
    }

    if (!projectResult) {
      // Still processing, wait a bit
      const checkResult = setInterval(() => {
        if (projectResult) {
          clearInterval(checkResult);
          res.status(200).json(projectResult);
        } else if (uploadError) {
          clearInterval(checkResult);
          res.status(400).json({ error: uploadError });
        }
      }, 100);

      // Timeout after 5 minutes
      setTimeout(() => {
        clearInterval(checkResult);
        if (!res.headersSent) {
          res.status(500).json({ error: "アップロードがタイムアウトしました" });
        }
      }, 5 * 60 * 1000);
    } else {
      res.status(200).json(projectResult);
    }
  });

  busboy.on("error", (err: Error) => {
    logger.error("Busboy error", { userId: user?.id }, err);
    if (!res.headersSent) {
      res.status(500).json({ error: "アップロード処理中にエラーが発生しました" });
    }
  });

  req.pipe(busboy);
});

/**
 * GET /api/upload/status
 * Check upload endpoint health
 */
uploadRouter.get("/status", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    maxFileSize: MAX_FILE_SIZE,
    allowedMimeTypes: ALLOWED_MIME_TYPES,
  });
});
