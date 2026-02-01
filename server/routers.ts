import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { createLogger } from "./_core/logger";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { z } from "zod";
import * as db from "./db";
import { processVideo } from "./videoProcessor";
import { generateStepsForProject, regenerateStep } from "./stepGenerator";
import { generateSlides } from "./slideGenerator";
import { generateAudioForProject, generateVideo } from "./videoGenerator";
import { getAvailableVoices, type TTSVoice } from "./_core/tts";
import { storagePut } from "./storage";

const logger = createLogger("Router");

// セキュリティ: エラーメッセージからセンシティブ情報を除去
function sanitizeError(error: unknown): string {
  if (error instanceof Error) {
    // スタックトレースやファイルパスを含まないメッセージのみを返す
    const message = error.message;
    // ファイルパスを除去
    const sanitized = message.replace(/\/[\w\/.-]+/g, "[path]");
    return sanitized.substring(0, 200); // 長すぎるメッセージを切り詰め
  }
  return "Unknown error";
}

export const appRouter = router({
    // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  project: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      return db.getProjectsByUserId(ctx.user.id);
    }),
    
    getById: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ ctx, input }) => {
        // セキュリティ: ユーザーIDによる所有者チェック
        return db.getProjectById(input.id, ctx.user.id);
      }),
    
    create: protectedProcedure
      .input(z.object({
        title: z.string(),
        description: z.string().optional(),
        videoBase64: z.string(),
        fileName: z.string(),
        contentType: z.string(),
      }))
      .mutation(async ({ ctx, input }) => {
        // Base64からバッファに変換（検証付き）
        let videoBuffer: Buffer;
        try {
          videoBuffer = Buffer.from(input.videoBase64, "base64");
          // Base64デコード結果の妥当性チェック
          if (videoBuffer.length === 0) {
            throw new Error("空のファイルです");
          }
          // 極端に大きなファイルの拒否（700MB上限）
          const MAX_SIZE = 700 * 1024 * 1024;
          if (videoBuffer.length > MAX_SIZE) {
            throw new Error("ファイルサイズが大きすぎます");
          }
        } catch (error) {
          if (error instanceof Error && error.message.includes("ファイル")) {
            throw error;
          }
          throw new Error("無効な動画データです。ファイルが破損している可能性があります。");
        }
        const videoKey = `projects/${ctx.user.id}/videos/${Date.now()}_${input.fileName}`;

        // ストレージにアップロード
        const { url: videoUrl } = await storagePut(videoKey, videoBuffer, input.contentType);

        const projectId = await db.createProject({
          userId: ctx.user.id,
          title: input.title,
          description: input.description,
          videoUrl,
          videoKey,
          status: "uploading",
        });
        return { projectId, videoUrl, videoKey };
      }),
    
    updateStatus: protectedProcedure
      .input(z.object({
        id: z.number(),
        status: z.enum(["uploading", "processing", "completed", "failed"]),
      }))
      .mutation(async ({ input }) => {
        await db.updateProjectStatus(input.id, input.status);
        return { success: true };
      }),
    
    getProgress: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ ctx, input }) => {
        // セキュリティ: ユーザーIDによる所有者チェック
        const project = await db.getProjectById(input.id, ctx.user.id);
        if (!project) {
          throw new Error("プロジェクトが見つかりません");
        }
        return {
          status: project.status,
          progress: project.processingProgress ?? 0,
          message: project.processingMessage ?? "",
          errorMessage: project.errorMessage ?? null,
        };
      }),

    // 再試行機能
    retry: protectedProcedure
      .input(z.object({
        projectId: z.number(),
        threshold: z.number().optional(),
        minInterval: z.number().optional(),
        maxFrames: z.number().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { projectId, threshold, minInterval, maxFrames } = input;

        // セキュリティ: プロジェクトの所有者チェック
        const project = await db.getProjectById(projectId, ctx.user.id);
        if (!project) {
          throw new Error("プロジェクトが見つかりません");
        }

        // 失敗またはアップロード状態のプロジェクトのみ再試行可能
        if (project.status !== "failed" && project.status !== "uploading") {
          throw new Error("このプロジェクトは再試行できません");
        }

        // 既存のフレームとステップを削除
        await db.deleteFramesByProjectId(projectId);
        await db.deleteStepsByProjectId(projectId);

        // エラーメッセージをクリア
        await db.clearProjectError(projectId);

        // ステータスを処理中に更新
        await db.updateProjectStatus(projectId, "processing");
        await db.updateProjectProgress(projectId, 0, "再処理を開始しています...");

        // 動画を処理（バックグラウンドで実行）
        processVideo(projectId, project.videoUrl, project.videoKey, { threshold, minInterval, maxFrames })
          .then(async () => {
            await db.updateProjectProgress(projectId, 100, "処理が完了しました");
            await db.updateProjectStatus(projectId, "completed");
          })
          .catch(async (error) => {
            const errorMessage = error instanceof Error ? error.message : "動画処理中にエラーが発生しました";
            logger.error("Retry processing failed", { projectId }, error instanceof Error ? error : undefined);
            await db.updateProjectError(projectId, errorMessage);
          });

        return { success: true, message: "Retry started" };
      }),

    // エラーログのエクスポート（管理者向け）
    exportErrorLogs: protectedProcedure
      .input(z.object({ format: z.enum(["json", "csv"]) }))
      .query(async ({ ctx, input }) => {
        // 自分の失敗したプロジェクトのみ取得
        const projects = await db.getProjectsByUserId(ctx.user.id);
        const failedProjects = projects.filter(p => p.status === "failed");

        const errorLogs = failedProjects.map(p => ({
          projectId: p.id,
          title: p.title,
          status: p.status,
          errorMessage: p.errorMessage || "不明なエラー",
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        }));

        if (input.format === "csv") {
          const headers = "プロジェクトID,タイトル,ステータス,エラーメッセージ,作成日,更新日";
          const rows = errorLogs.map(log =>
            `${log.projectId},"${log.title}","${log.status}","${log.errorMessage}","${log.createdAt}","${log.updatedAt}"`
          );
          return { data: [headers, ...rows].join("\n"), format: "csv" };
        }

        return { data: JSON.stringify(errorLogs, null, 2), format: "json" };
      }),

    // プロジェクト削除
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        // セキュリティ: ユーザーIDによる所有者チェック
        await db.deleteProject(input.id, ctx.user.id);
        return { success: true };
      }),

    // 一括削除
    bulkDelete: protectedProcedure
      .input(z.object({ ids: z.array(z.number()) }))
      .mutation(async ({ ctx, input }) => {
        // セキュリティ: 各プロジェクトの所有者チェックを行いながら削除
        for (const id of input.ids) {
          await db.deleteProject(id, ctx.user.id);
        }
        return { success: true, deletedCount: input.ids.length };
      }),

    // プロジェクト複製
    duplicate: protectedProcedure
      .input(z.object({ projectId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        // セキュリティ: プロジェクトの所有者チェック
        const project = await db.getProjectById(input.projectId, ctx.user.id);
        if (!project) {
          throw new Error("プロジェクトが見つかりません");
        }

        // 新しいプロジェクトを作成（タイトルに「(コピー)」を付加）
        const newProjectId = await db.createProject({
          userId: ctx.user.id,
          title: `${project.title} (コピー)`,
          description: project.description,
          videoUrl: project.videoUrl,
          videoKey: project.videoKey,
          status: "uploading", // 新規作成として扱う
        });

        return { success: true, projectId: newProjectId };
      }),

    processVideo: protectedProcedure
      .input(z.object({
        projectId: z.number(),
        videoUrl: z.string(),
        videoKey: z.string(),
        threshold: z.number().optional(),
        minInterval: z.number().optional(),
        maxFrames: z.number().optional(),
      }))
      .mutation(async ({ input }) => {
        const { projectId, videoUrl, videoKey, threshold, minInterval, maxFrames } = input;
        
        console.log(`[Router] processVideo called with:`, { projectId, videoUrl: videoUrl.substring(0, 100), videoKey, threshold, minInterval, maxFrames });
        
        // ステータスを処理中に更新
        await db.updateProjectStatus(projectId, "processing");
        
        try {
          // 動画を処理（バックグラウンドで実行）
          processVideo(projectId, videoUrl, videoKey, { threshold, minInterval, maxFrames })
            .then(async () => {
              // 進捗を100%に更新
              await db.updateProjectProgress(projectId, 100, "処理が完了しました");
              await db.updateProjectStatus(projectId, "completed");
            })
            .catch(async (error) => {
              // エラーメッセージを取得（ユーザーに表示するため）
              const errorMessage = error instanceof Error ? error.message : "動画処理中にエラーが発生しました";
              logger.error("Video processing failed", { projectId }, error instanceof Error ? error : undefined);
              // エラーメッセージをDBに保存
              await db.updateProjectError(projectId, errorMessage);
            });

          return { success: true, message: "Processing started" };
        } catch (error) {
          await db.updateProjectStatus(projectId, "failed");
          throw error;
        }
      }),
  }),
  
  frame: router({
    listByProject: protectedProcedure
      .input(z.object({ projectId: z.number() }))
      .query(async ({ ctx, input }) => {
        // セキュリティ: ユーザーIDによる所有者チェック
        return db.getFramesByProjectId(input.projectId, ctx.user.id);
      }),
  }),

  step: router({
    listByProject: protectedProcedure
      .input(z.object({ projectId: z.number() }))
      .query(async ({ ctx, input }) => {
        // セキュリティ: ユーザーIDによる所有者チェック
        return db.getStepsByProjectId(input.projectId, ctx.user.id);
      }),

    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        title: z.string().optional(),
        operation: z.string().optional(),
        description: z.string().optional(),
        narration: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { id, ...data } = input;
        // セキュリティ: ユーザーIDによる所有者チェック
        await db.updateStep(id, data, ctx.user.id);
        return { success: true };
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        // セキュリティ: ユーザーIDによる所有者チェック
        await db.deleteStep(input.id, ctx.user.id);
        return { success: true };
      }),
    
    generate: protectedProcedure
      .input(z.object({ projectId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        // セキュリティ: プロジェクトの所有者チェック
        const project = await db.getProjectById(input.projectId, ctx.user.id);
        if (!project) {
          throw new Error("プロジェクトが見つかりません");
        }

        // バックグラウンドでステップ生成を実行
        generateStepsForProject(input.projectId)
          .then(async () => {
            // 進捗を100%に更新
            await db.updateProjectProgress(input.projectId, 100, "ステップ生成が完了しました");
            logger.info("Steps generated successfully", { projectId: input.projectId });
          })
          .catch(async (error) => {
            // エラーメッセージを取得（ユーザーに表示するため）
            const errorMessage = error instanceof Error ? error.message : "AI解析中にエラーが発生しました";
            logger.error("Step generation failed", { projectId: input.projectId }, error instanceof Error ? error : undefined);
            // エラーメッセージをDBに保存
            await db.updateProjectError(input.projectId, errorMessage);
          });

        return { success: true, message: "Step generation started" };
      }),
    
    regenerate: protectedProcedure
      .input(z.object({ stepId: z.number(), frameId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        // セキュリティ: ステップの所有者チェック
        const step = await db.getStepById(input.stepId, ctx.user.id);
        if (!step) {
          throw new Error("ステップが見つかりません");
        }
        // セキュリティ: フレームの所有者チェック
        const frame = await db.getFrameById(input.frameId, ctx.user.id);
        if (!frame) {
          throw new Error("フレームが見つかりません");
        }
        await regenerateStep(input.stepId, input.frameId);
        return { success: true };
      }),

    reorder: protectedProcedure
      .input(z.object({
        projectId: z.number(),
        stepIds: z.array(z.number()),
      }))
      .mutation(async ({ ctx, input }) => {
        // セキュリティ: プロジェクトの所有者チェック
        const project = await db.getProjectById(input.projectId, ctx.user.id);
        if (!project) {
          throw new Error("プロジェクトが見つかりません");
        }
        // ステップの並び順を更新
        await db.reorderSteps(input.projectId, input.stepIds);
        return { success: true };
      }),
  }),
  
  slide: router({
    generate: protectedProcedure
      .input(z.object({ projectId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        try {
          console.log(`[Router] Starting slide generation for project ${input.projectId}`);
          // セキュリティ: プロジェクトの所有者チェック
          const project = await db.getProjectById(input.projectId, ctx.user.id);
          if (!project) {
            console.error(`[Router] Project ${input.projectId} not found for user ${ctx.user.id}`);
            throw new Error("プロジェクトが見つかりません");
          }
          console.log(`[Router] Project found, calling generateSlides...`);
          const slideUrl = await generateSlides(input.projectId);
          console.log(`[Router] Slide generation successful: ${slideUrl}`);
          return { success: true, slideUrl };
        } catch (error) {
          console.error(`[Router] Slide generation error:`, error);
          throw error;
        }
      }),
  }),

  video: router({
    // 利用可能な音声一覧を取得
    getVoices: protectedProcedure.query(() => {
      return getAvailableVoices();
    }),

    generateAudio: protectedProcedure
      .input(z.object({
        projectId: z.number(),
        voice: z.enum(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        // セキュリティ: プロジェクトの所有者チェック
        const project = await db.getProjectById(input.projectId, ctx.user.id);
        if (!project) {
          throw new Error("プロジェクトが見つかりません");
        }
        await generateAudioForProject(input.projectId, input.voice as TTSVoice);
        return { success: true };
      }),

    generate: protectedProcedure
      .input(z.object({ projectId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        // セキュリティ: プロジェクトの所有者チェック
        const project = await db.getProjectById(input.projectId, ctx.user.id);
        if (!project) {
          throw new Error("プロジェクトが見つかりません");
        }
        const videoUrl = await generateVideo(input.projectId);
        return { success: true, videoUrl };
      }),
  }),
});

export type AppRouter = typeof appRouter;
