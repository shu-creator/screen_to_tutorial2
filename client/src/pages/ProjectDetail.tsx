import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, Image as ImageIcon, FileText, Download, Wand2, Loader2, CheckCircle, XCircle, Clock, RefreshCw, Settings, Play, Film, GripVertical, Presentation, Volume2, Pause, Pencil, Trash2, Gauge, Mic } from "lucide-react";
import { Link, useParams } from "wouter";
import { toast } from "sonner";
import { useState, useEffect, useCallback, useRef } from "react";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { SlidePreview } from "@/components/SlidePreview";
import NotFound from "./NotFound";

// ソート可能なステップカードコンポーネント
type StepData = {
  id: number;
  frameId: number;
  title: string;
  operation: string;
  description: string;
  narration: string | null;
  audioUrl: string | null;
};

type FrameData = {
  id: number;
  imageUrl: string;
  frameNumber: number;
  timestamp: number;
};

type StepAudioMode = "auto" | "tts" | "original" | "mixed" | "silent";
type StepUpdateData = {
  title?: string;
  operation?: string;
  description?: string;
  narration?: string;
  tStart?: number;
  tEnd?: number;
  audioMode?: StepAudioMode;
  markReviewed?: true;
};

function formatReviewReason(reason: string): string {
  const labels: Record<string, string> = {
    "fallback:chunk_authoring_failed": "執筆fallback",
    "fallback:unassigned_segment": "未割当セグメント",
    "fallback:legacy_step_analysis_failed": "旧解析fallback",
    "verification:unverified_ui_label": "UIラベル未確認",
    "verification:low_confidence": "低信頼度",
  };
  return labels[reason] ?? reason;
}

function formatReviewDetails(review: { warnings: string[]; reviewReasons: string[] }): string {
  return [...review.warnings, ...review.reviewReasons.map(formatReviewReason)].filter(Boolean).join(" / ");
}

const LOW_CONFIDENCE_THRESHOLD = 0.5;

function formatStepTime(ms: number): string {
  if (!Number.isFinite(ms)) return "-";
  const seconds = Math.max(0, ms / 1000);
  if (seconds < 60) {
    const displaySeconds = seconds < 10
      ? Math.min(9.9, seconds).toFixed(1)
      : Math.min(59, Math.round(seconds)).toString();
    return `${displaySeconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${rest}`;
}

function formatAudioMode(mode: string): string {
  const labels: Record<string, string> = {
    auto: "自動",
    tts: "TTS",
    original: "元音声",
    mixed: "混合",
    silent: "無音",
  };
  return labels[mode] ?? mode;
}

function SortableStepCard({
  step,
  index,
  isEditing,
  onToggleEdit,
  onUpdate,
  onDelete,
  onRegenerate,
  isRegenerating,
  frame,
  review,
}: {
  step: StepData;
  index: number;
  isEditing: boolean;
  onToggleEdit: () => void;
  onUpdate: (id: number, data: StepUpdateData) => void;
  onDelete: (id: number) => void;
  onRegenerate: (stepId: number, frameId: number) => void;
  isRegenerating: boolean;
  frame?: FrameData;
  review?: {
    needsReview: boolean;
    reviewReasons: string[];
    warnings: string[];
    confidence: number;
    tStart: number;
    tEnd: number;
    audioMode: string;
  };
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: step.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <Card id={`step-${step.id}`} ref={setNodeRef} style={style} className={isDragging ? "shadow-lg" : ""}>
      <CardHeader>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 flex-1 flex-col gap-4 sm:flex-row">
            {/* ドラッグハンドル */}
            <button
              {...attributes}
              {...listeners}
              className="cursor-grab self-start p-1 text-muted-foreground hover:text-foreground active:cursor-grabbing"
              aria-label="ドラッグして並び替え"
            >
              <GripVertical className="h-5 w-5" />
            </button>
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary font-bold text-primary-foreground">
              {index + 1}
            </div>
            <div className="min-w-0 flex-1">
              {isEditing ? (
                <div className="space-y-4">
                  <div>
                    <Label htmlFor={`title-${step.id}`}>タイトル</Label>
                    <Input
                      id={`title-${step.id}`}
                      defaultValue={step.title}
                      onBlur={(e) => {
                        if (e.target.value !== step.title) onUpdate(step.id, { title: e.target.value });
                      }}
                    />
                  </div>
                  <div>
                    <Label htmlFor={`operation-${step.id}`}>操作</Label>
                    <Input
                      id={`operation-${step.id}`}
                      defaultValue={step.operation}
                      onBlur={(e) => {
                        if (e.target.value !== step.operation) onUpdate(step.id, { operation: e.target.value });
                      }}
                    />
                  </div>
                  <div>
                    <Label htmlFor={`description-${step.id}`}>説明</Label>
                    <Textarea
                      id={`description-${step.id}`}
                      defaultValue={step.description}
                      rows={3}
                      onBlur={(e) => {
                        if (e.target.value !== step.description) onUpdate(step.id, { description: e.target.value });
                      }}
                    />
                  </div>
                  <div>
                    <Label htmlFor={`narration-${step.id}`}>ナレーション</Label>
                    <Textarea
                      id={`narration-${step.id}`}
                      defaultValue={step.narration || ""}
                      rows={2}
                      onBlur={(e) => {
                        if (e.target.value !== (step.narration || "")) onUpdate(step.id, { narration: e.target.value });
                      }}
                    />
                  </div>
                  {review && (
                    <>
                      {review.needsReview && (
                        <Alert className="border-destructive/40">
                          <AlertTitle>要レビュー</AlertTitle>
                          <AlertDescription>
                            {formatReviewDetails(review) || "信頼度が低いステップです"}
                          </AlertDescription>
                        </Alert>
                      )}
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <Label htmlFor={`t-start-${step.id}`}>開始(ms)</Label>
                          <Input
                            id={`t-start-${step.id}`}
                            type="number"
                            min={0}
                            defaultValue={review.tStart}
                            onBlur={(e) => {
                              if (e.target.value.trim() === "") {
                                e.target.value = String(review.tStart);
                                return;
                              }
                              const value = Number(e.target.value);
                              if (!Number.isFinite(value)) {
                                e.target.value = String(review.tStart);
                                return;
                              }
                              const rounded = Math.round(value);
                              if (rounded !== review.tStart) onUpdate(step.id, { tStart: rounded });
                            }}
                          />
                        </div>
                        <div>
                          <Label htmlFor={`t-end-${step.id}`}>終了(ms)</Label>
                          <Input
                            id={`t-end-${step.id}`}
                            type="number"
                            min={0}
                            defaultValue={review.tEnd}
                            onBlur={(e) => {
                              if (e.target.value.trim() === "") {
                                e.target.value = String(review.tEnd);
                                return;
                              }
                              const value = Number(e.target.value);
                              if (!Number.isFinite(value)) {
                                e.target.value = String(review.tEnd);
                                return;
                              }
                              const rounded = Math.round(value);
                              if (rounded !== review.tEnd) onUpdate(step.id, { tEnd: rounded });
                            }}
                          />
                        </div>
                      </div>
                      <div>
                        <Label htmlFor={`audio-mode-${step.id}`}>音声モード</Label>
                        <select
                          id={`audio-mode-${step.id}`}
                          defaultValue={review.audioMode}
                          onChange={(e) => onUpdate(step.id, { audioMode: e.target.value as StepAudioMode })}
                          className="w-full px-3 py-2 border rounded-md bg-background text-sm"
                        >
                          <option value="auto">自動</option>
                          <option value="tts">TTSナレーション</option>
                          <option value="original">元録画の音声</option>
                          <option value="mixed">元音声+TTS</option>
                          <option value="silent">無音</option>
                        </select>
                      </div>
                      {review.needsReview && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => onUpdate(step.id, { markReviewed: true })}
                        >
                          <CheckCircle className="h-4 w-4 mr-2" />
                          レビュー済みにする
                        </Button>
                      )}
                    </>
                  )}
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2 flex-wrap">
                    <CardTitle>{step.title}</CardTitle>
                    {review?.needsReview && (
                      <Badge
                        variant="destructive"
                        title={formatReviewDetails(review) || "信頼度が低いステップです"}
                      >
                        要レビュー
                      </Badge>
                    )}
                  </div>
                  {review?.needsReview && (
                    <p className="mt-1 text-xs leading-relaxed text-destructive">
                      {formatReviewDetails(review) || "信頼度が低いステップです"}
                    </p>
                  )}
                  {review && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="outline" className="gap-1">
                        <Clock className="h-3 w-3" />
                        {formatStepTime(review.tStart)}-{formatStepTime(review.tEnd)}
                      </Badge>
                      <Badge
                        variant="outline"
                        className={
                          review.needsReview && review.confidence < LOW_CONFIDENCE_THRESHOLD
                            ? "gap-1 border-destructive/40 text-destructive"
                            : "gap-1"
                        }
                      >
                        <Gauge className="h-3 w-3" />
                        {Math.round(review.confidence * 100)}%
                      </Badge>
                      <Badge variant="outline" className="gap-1">
                        <Volume2 className="h-3 w-3" />
                        {formatAudioMode(review.audioMode)}
                      </Badge>
                    </div>
                  )}
                  <CardDescription className="mt-2">
                    <strong>操作:</strong> {step.operation}
                  </CardDescription>
                  <p className="text-sm text-foreground mt-2">{step.description}</p>
                  {step.narration && (
                    <div className="mt-2 space-y-2">
                      <p className="flex items-start gap-2 text-sm text-muted-foreground italic">
                        <Mic className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>{step.narration}</span>
                      </p>
                      {step.audioUrl && (
                        <audio
                          src={step.audioUrl}
                          controls
                          className="h-8 w-full max-w-xs"
                          preload="none"
                        />
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
          {/* フレームプレビュー */}
          {frame && !isEditing && (
            <div className="aspect-video w-full overflow-hidden rounded bg-muted sm:w-40">
              <img
                src={frame.imageUrl}
                alt={`ステップ ${index + 1} のフレーム`}
                className="w-full h-full object-cover"
              />
            </div>
          )}
          <div className="flex flex-wrap gap-2 lg:w-36 lg:flex-col">
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={onToggleEdit}
                aria-label={isEditing ? "編集を終了" : "ステップを編集"}
              >
                {isEditing ? <CheckCircle className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
                {isEditing ? "完了" : "編集"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onDelete(step.id)}
                className="text-destructive hover:text-destructive"
                aria-label="ステップを削除"
              >
                <Trash2 className="h-4 w-4" />
                削除
              </Button>
            </div>
            {review?.needsReview && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onUpdate(step.id, { markReviewed: true })}
                className="w-full sm:w-auto lg:w-full"
              >
                <CheckCircle className="h-3 w-3 mr-1" />
                レビュー済み
              </Button>
            )}
            {frame && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onRegenerate(step.id, step.frameId)}
                disabled={isRegenerating}
                className="w-full sm:w-auto lg:w-full"
              >
                {isRegenerating ? (
                  <>
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    再生成中...
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-3 w-3 mr-1" />
                    AIで再生成
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
    </Card>
  );
}

export default function ProjectDetail() {
  const params = useParams<{ id: string }>();
  const parsedProjectId = Number(params.id);
  const isValidProjectId = Number.isInteger(parsedProjectId) && parsedProjectId > 0;
  const projectId = isValidProjectId ? parsedProjectId : 0;
  
  const { data: project, isLoading: projectLoading, refetch: refetchProject } = trpc.project.getById.useQuery(
    { id: projectId },
    { enabled: isValidProjectId }
  );
  const { data: frames, isLoading: framesLoading, refetch: refetchFrames } = trpc.frame.listByProject.useQuery(
    { projectId },
    { enabled: isValidProjectId }
  );
  const { data: artifactInfo, refetch: refetchArtifactInfo } = trpc.step.artifactInfo.useQuery(
    { projectId },
    { enabled: !isNaN(projectId) }
  );
  const { data: steps, isLoading: stepsLoading, refetch: refetchSteps } = trpc.step.listByProject.useQuery(
    { projectId },
    { enabled: isValidProjectId }
  );
  const utils = trpc.useUtils();
  const [progressData, setProgressData] = useState<{ progress: number; message: string; errorMessage?: string | null } | null>(null);

  // 指数バックオフ付きポーリング用の状態
  const pollingIntervalRef = useRef(1000);
  const pollingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // 処理中のプロジェクトの進捗をポーリング（指数バックオフ付き）
  useEffect(() => {
    if (!project || (project.status !== "processing" && project.status !== "failed")) {
      pollingIntervalRef.current = 1000; // Reset interval
      return;
    }

    const poll = async () => {
      try {
        const progress = await utils.project.getProgress.fetch({ id: projectId });
        setProgressData({
          progress: progress.progress,
          message: progress.message,
          errorMessage: progress.errorMessage,
        });

        // 成功時はインターバルをリセット
        pollingIntervalRef.current = 1000;

        if (progress.status === "completed" || (progress.status === "failed" && progress.errorMessage)) {
          refetchProject();
          refetchFrames();
          refetchSteps();
      refetchArtifactInfo();
          return; // ポーリング終了
        }
      } catch (error) {
        console.error("Failed to fetch progress:", error);
        // エラー時は指数バックオフ（最大30秒）
        pollingIntervalRef.current = Math.min(pollingIntervalRef.current * 1.5, 30000);
      }

      // 次のポーリングをスケジュール
      pollingTimeoutRef.current = setTimeout(poll, pollingIntervalRef.current);
    };

    // 初回ポーリング開始
    pollingTimeoutRef.current = setTimeout(poll, pollingIntervalRef.current);

    return () => {
      if (pollingTimeoutRef.current) {
        clearTimeout(pollingTimeoutRef.current);
      }
    };
  }, [project?.status, projectId, utils, refetchProject, refetchFrames, refetchSteps]);
  
  const generateStepsMutation = trpc.step.generate.useMutation();
  const updateStepMutation = trpc.step.update.useMutation();
  const deleteStepMutation = trpc.step.delete.useMutation();
  const reorderStepsMutation = trpc.step.reorder.useMutation();
  const regenerateStepMutation = trpc.step.regenerate.useMutation();
  const retryProjectMutation = trpc.project.retry.useMutation();

  // ステップ再生成中の状態
  const [regeneratingStepId, setRegeneratingStepId] = useState<number | null>(null);
  const generateSlidesMutation = trpc.slide.generate.useMutation();
  const generateAudioMutation = trpc.video.generateAudio.useMutation();
  const generateVideoMutation = trpc.video.generate.useMutation();
  const { data: availableVoices } = trpc.video.getVoices.useQuery();

  // DnD センサー設定
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // 8px以上動かさないとドラッグ開始しない
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // ドラッグ終了時のハンドラー
  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;

      if (over && active.id !== over.id && steps) {
        const oldIndex = steps.findIndex((s) => s.id === active.id);
        const newIndex = steps.findIndex((s) => s.id === over.id);

        if (oldIndex !== -1 && newIndex !== -1) {
          const newOrder = arrayMove(steps, oldIndex, newIndex);
          const stepIds = newOrder.map((s) => s.id);

          try {
            await reorderStepsMutation.mutateAsync({ projectId, stepIds });
            refetchSteps();
            refetchArtifactInfo();
            toast.success("ステップの順序を更新しました");
          } catch (error) {
            toast.error("順序の更新に失敗しました");
          }
        }
      }
    },
    [steps, projectId, reorderStepsMutation, refetchSteps, refetchArtifactInfo]
  );

  const [editingStepId, setEditingStepId] = useState<number | null>(null);
  const [isRetryDialogOpen, setIsRetryDialogOpen] = useState(false);
  const [isSlidePreviewOpen, setIsSlidePreviewOpen] = useState(false);
  const [isGeneratingSlides, setIsGeneratingSlides] = useState(false);
  const [isGeneratingVideo, setIsGeneratingVideo] = useState(false);
  const [videoGenerationProgress, setVideoGenerationProgress] = useState<{
    progress: number;
    message: string;
  } | null>(null);
  const [selectedVoice, setSelectedVoice] = useState<string>("nova");
  const [audioMode, setAudioMode] = useState<"auto" | "tts" | "original" | "mixed" | "silent">("auto");
  const [slideUrl, setSlideUrl] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [retryParams, setRetryParams] = useState({
    threshold: 5.0,
    minInterval: 30,
    maxFrames: 100,
  });
  const reviewSteps = (steps ?? []).filter((step) => artifactInfo?.reviewByStepId?.[step.id]?.needsReview);
  const reviewStepCount = reviewSteps.length;
  const focusNextReviewStep = () => {
    const nextStep = reviewSteps[0];
    if (!nextStep) return;
    setEditingStepId(nextStep.id);
    window.setTimeout(() => {
      document.getElementById(`step-${nextStep.id}`)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }, 0);
  };

  useEffect(() => {
    if (!availableVoices || availableVoices.length === 0) return;
    if (availableVoices.some((voice) => voice.id === selectedVoice)) return;
    setSelectedVoice(availableVoices[0].id);
  }, [availableVoices, selectedVoice]);

  // 再試行ハンドラー
  const handleRetry = async () => {
    try {
      await retryProjectMutation.mutateAsync({
        projectId,
        threshold: retryParams.threshold,
        minInterval: retryParams.minInterval,
        maxFrames: retryParams.maxFrames,
      });
      toast.success("再処理を開始しました");
      setIsRetryDialogOpen(false);
      refetchProject();
    } catch (error) {
      toast.error("再処理の開始に失敗しました");
    }
  };

  const handleGenerateSteps = async () => {
    try {
      await generateStepsMutation.mutateAsync({ projectId });
      toast.success("ステップの生成を開始しました");
      setProgressData({
        progress: 66,
        message: "ステップ生成を開始しています...",
      });
      refetchProject();

      // ポーリングで結果を確認
      const pollInterval = setInterval(() => {
        refetchSteps();
        refetchArtifactInfo();
        refetchProject();
      }, 3000);
      
      setTimeout(() => {
        clearInterval(pollInterval);
      }, 60000); // 1分後にポーリング停止
      
    } catch (error) {
      toast.error("ステップの生成に失敗しました");
    }
  };

  const handleUpdateStep = async (stepId: number, data: StepUpdateData) => {
    try {
      await updateStepMutation.mutateAsync({ projectId, id: stepId, ...data });
      toast.success("ステップを更新しました");
      refetchSteps();
      refetchArtifactInfo();
    } catch (error) {
      const message = error instanceof Error ? error.message : "ステップの更新に失敗しました";
      toast.error(message);
    }
  };

  const handleDeleteStep = async (stepId: number) => {
    if (!confirm("このステップを削除しますか?")) return;

    try {
      await deleteStepMutation.mutateAsync({ projectId, id: stepId });
      toast.success("ステップを削除しました");
      refetchSteps();
      refetchArtifactInfo();
    } catch (error) {
      toast.error("ステップの削除に失敗しました");
    }
  };

  const handleRegenerateStep = async (stepId: number, frameId: number) => {
    setRegeneratingStepId(stepId);
    try {
      await regenerateStepMutation.mutateAsync({ projectId, stepId, frameId });
      toast.success("ステップをAIで再生成しました");
      refetchSteps();
      refetchArtifactInfo();
    } catch (error) {
      toast.error("ステップの再生成に失敗しました");
    } finally {
      setRegeneratingStepId(null);
    }
  };

  // スライド生成とダウンロード
  const handleGenerateSlides = async () => {
    setIsGeneratingSlides(true);
    try {
      const result = await generateSlidesMutation.mutateAsync({ projectId });
      setSlideUrl(result.slideUrl);
      toast.success("スライドを生成しました");
      // 自動ダウンロード
      downloadFile(result.slideUrl, `${project?.title || "slides"}.pptx`);
    } catch (error) {
      toast.error("スライドの生成に失敗しました");
    } finally {
      setIsGeneratingSlides(false);
    }
  };

  // 動画生成（音声生成 → 動画結合）
  const handleGenerateVideo = async () => {
    setIsGeneratingVideo(true);
    setVideoGenerationProgress({ progress: 0, message: "動画生成を開始しています..." });
    try {
      // 1. 音声を生成
      setVideoGenerationProgress({ progress: 10, message: "ナレーション音声を生成中..." });
      const audioResult = await generateAudioMutation.mutateAsync({
        projectId,
        voice: selectedVoice,
      });
      if (audioResult.silentFallbackCount > 0) {
        toast.warning(
          `${audioResult.silentFallbackCount}件のステップでTTSが失敗し無音になっています。TTSのAPIキー設定を確認してください。`,
        );
      }

      // 音声生成後にステップを再取得（audioUrlを更新するため）
      setVideoGenerationProgress({ progress: 50, message: "音声生成完了。動画を生成中..." });
      await refetchSteps();
      refetchArtifactInfo();

      // 2. 動画を生成
      setVideoGenerationProgress({ progress: 60, message: "フレームと音声を結合中..." });
      const result = await generateVideoMutation.mutateAsync({ projectId, audioMode });
      if (result.stillImageFallbackCount > 0) {
        toast.warning(
          `${result.stillImageFallbackCount}件のステップはクリップ切り出しに失敗し静止画になっています`,
        );
      }

      setVideoGenerationProgress({ progress: 90, message: "動画をアップロード中..." });
      setVideoUrl(result.videoUrl);

      setVideoGenerationProgress({ progress: 100, message: "完了しました" });
      toast.success("動画を生成しました");

      // 自動ダウンロード
      downloadFile(result.videoUrl, `${project?.title || "tutorial"}.mp4`);
    } catch (error) {
      toast.error("動画の生成に失敗しました");
    } finally {
      setIsGeneratingVideo(false);
      setVideoGenerationProgress(null);
    }
  };

  // ファイルダウンロードヘルパー（CORS問題を回避）
  const downloadFile = async (url: string, filename: string) => {
    try {
      // fetchでファイルを取得し、Blobとしてダウンロード
      const response = await fetch(url);
      const blob = await response.blob();
      const blobUrl = window.URL.createObjectURL(blob);
      
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      
      // Blob URLを解放
      window.URL.revokeObjectURL(blobUrl);
    } catch (error) {
      console.error('Download failed:', error);
      // フォールバック: 直接リンクを開く
      window.open(url, '_blank');
    }
  };

  if (!isValidProjectId) {
    return <NotFound />;
  }

  if (projectLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </DashboardLayout>
    );
  }

  if (!project) {
    return (
      <DashboardLayout>
        <div className="text-center py-12">
          <h2 className="text-2xl font-bold text-foreground mb-4">プロジェクトが見つかりません</h2>
          <Link href="/projects">
            <Button>
              <ArrowLeft className="h-4 w-4 mr-2" />
              プロジェクト一覧に戻る
            </Button>
          </Link>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-start gap-4">
            <Link href="/projects">
              <Button variant="ghost" size="icon">
                <ArrowLeft className="h-5 w-5" />
              </Button>
            </Link>
            <div className="min-w-0">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h1 className="break-all text-2xl font-bold text-foreground sm:text-3xl">{project.title}</h1>
                {project.status === "processing" && (
                  <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm bg-yellow-100 text-yellow-700">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    処理中
                  </span>
                )}
                {project.status === "completed" && (
                  <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm bg-green-100 text-green-700">
                    <CheckCircle className="h-4 w-4" />
                    完了
                  </span>
                )}
                {project.status === "failed" && (
                  <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm bg-red-100 text-red-700">
                    <XCircle className="h-4 w-4" />
                    失敗
                  </span>
                )}
              </div>
              <p className="text-muted-foreground mt-1">{project.description}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={slideUrl ? () => downloadFile(slideUrl, `${project.title}.pptx`) : handleGenerateSlides}
              disabled={isGeneratingSlides || !steps || steps.length === 0}
            >
              {isGeneratingSlides && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              <Download className="h-4 w-4 mr-2" />
              {slideUrl ? "スライドをダウンロード" : "スライドを生成"}
            </Button>
            <Button
              variant="outline"
              onClick={videoUrl ? () => downloadFile(videoUrl, `${project.title}.mp4`) : handleGenerateVideo}
              disabled={isGeneratingVideo || !steps || steps.length === 0}
            >
              {isGeneratingVideo && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              <Download className="h-4 w-4 mr-2" />
              {videoUrl ? "動画をダウンロード" : "動画を生成"}
            </Button>
          </div>
        </div>

        {/* 進捗表示 */}
        {project.status === "processing" && progressData && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">処理中...</CardTitle>
              <CardDescription>{progressData.message}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">進捗</span>
                  <span className="font-medium">{progressData.progress}%</span>
                </div>
                <Progress value={progressData.progress} className="h-3" />
              </div>
            </CardContent>
          </Card>
        )}

        {/* エラー表示と再試行ボタン */}
        {project.status === "failed" && (
          <Alert variant="destructive">
            <XCircle className="h-4 w-4" />
            <AlertTitle>処理が失敗しました</AlertTitle>
            <AlertDescription>
              {progressData?.errorMessage || project.errorMessage || "処理中にエラーが発生しました"}
            </AlertDescription>
            <div className="mt-4">
              <Dialog open={isRetryDialogOpen} onOpenChange={setIsRetryDialogOpen}>
                <DialogTrigger asChild>
                  <Button variant="outline" size="sm">
                    <RefreshCw className="h-4 w-4 mr-2" />
                    パラメータを調整して再試行
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-[500px]">
                  <DialogHeader>
                    <DialogTitle>
                      <Settings className="h-5 w-5 inline mr-2" />
                      処理パラメータの調整
                    </DialogTitle>
                    <DialogDescription>
                      フレーム抽出のパラメータを調整して再処理できます。動画の特性に応じて最適な設定を選んでください。
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-6 py-4">
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label>差分検知の閾値</Label>
                        <span className="text-sm text-muted-foreground">{retryParams.threshold.toFixed(1)}</span>
                      </div>
                      <Slider
                        value={[retryParams.threshold]}
                        onValueChange={([value]) => setRetryParams(prev => ({ ...prev, threshold: value }))}
                        min={1}
                        max={20}
                        step={0.5}
                      />
                      <p className="text-xs text-muted-foreground">
                        低い値：より多くのフレームを抽出（細かい変化も検出）<br />
                        高い値：大きな変化のみ抽出（フレーム数を削減）
                      </p>
                    </div>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label>最小フレーム間隔</Label>
                        <span className="text-sm text-muted-foreground">{retryParams.minInterval}フレーム</span>
                      </div>
                      <Slider
                        value={[retryParams.minInterval]}
                        onValueChange={([value]) => setRetryParams(prev => ({ ...prev, minInterval: value }))}
                        min={10}
                        max={120}
                        step={5}
                      />
                      <p className="text-xs text-muted-foreground">
                        連続するフレーム間の最小間隔。大きい値にすると重複が減ります。
                      </p>
                    </div>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label>最大フレーム数</Label>
                        <span className="text-sm text-muted-foreground">{retryParams.maxFrames}枚</span>
                      </div>
                      <Slider
                        value={[retryParams.maxFrames]}
                        onValueChange={([value]) => setRetryParams(prev => ({ ...prev, maxFrames: value }))}
                        min={10}
                        max={200}
                        step={10}
                      />
                      <p className="text-xs text-muted-foreground">
                        抽出するフレームの最大数。長い動画の場合は増やしてください。
                      </p>
                    </div>
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setIsRetryDialogOpen(false)}>
                      キャンセル
                    </Button>
                    <Button onClick={handleRetry} disabled={retryProjectMutation.isPending}>
                      {retryProjectMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                      <RefreshCw className="h-4 w-4 mr-2" />
                      再処理を開始
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </Alert>
        )}

        {/* Tabs */}
        <Tabs defaultValue="frames" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger
              value="frames"
              className="min-w-0 px-1 text-xs sm:px-2 sm:text-sm"
              aria-label={`フレーム (${frames?.length || 0})`}
            >
              <ImageIcon className="h-4 w-4" />
              フレーム<span className="hidden sm:inline"> ({frames?.length || 0})</span>
            </TabsTrigger>
            <TabsTrigger
              value="steps"
              className="min-w-0 px-1 text-xs sm:px-2 sm:text-sm"
              aria-label={`ステップ (${steps?.length || 0})`}
            >
              <FileText className="h-4 w-4" />
              ステップ<span className="hidden sm:inline"> ({steps?.length || 0})</span>
            </TabsTrigger>
            <TabsTrigger value="preview" className="min-w-0 px-1 text-xs sm:px-2 sm:text-sm">
              <Play className="h-4 w-4" />
              プレビュー
            </TabsTrigger>
          </TabsList>

          {/* Frames Tab */}
          <TabsContent value="frames" className="space-y-4">
            {framesLoading ? (
              <div className="flex items-center justify-center h-64">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
            ) : frames && frames.length > 0 ? (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {frames.map((frame) => (
                  <Card key={frame.id}>
                    <CardHeader>
                      <CardTitle className="text-sm">フレーム {frame.frameNumber}</CardTitle>
                      <CardDescription>
                        {Math.floor(frame.timestamp / 1000)}秒 | 差分スコア: {frame.diffScore}
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <img
                        src={frame.imageUrl}
                        alt={`Frame ${frame.frameNumber}`}
                        className="w-full h-auto rounded-md border"
                      />
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-12">
                  <ImageIcon className="h-16 w-16 text-muted-foreground mb-4" />
                  <h3 className="text-lg font-semibold mb-2 text-foreground">
                    フレームがありません
                  </h3>
                  <p className="text-muted-foreground text-center">
                    動画の処理が完了すると、ここにフレームが表示されます。
                  </p>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* Steps Tab */}
          <TabsContent value="steps" className="space-y-4">
            <div className="flex justify-end">
              <Button
                onClick={handleGenerateSteps}
                disabled={generateStepsMutation.isPending || !frames || frames.length === 0}
              >
                {generateStepsMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                <Wand2 className="h-4 w-4 mr-2" />
                AIでステップを生成
              </Button>
            </div>

            {stepsLoading ? (
              <div className="flex items-center justify-center h-64">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
            ) : steps && steps.length > 0 ? (
              <>
              {artifactInfo?.overview && (
                <Card className="border-primary/30">
                  <CardHeader>
                    <CardTitle className="text-lg">{artifactInfo.overview.task_title}</CardTitle>
                    {artifactInfo.overview.preconditions.length > 0 && (
                      <CardDescription>
                        前提: {artifactInfo.overview.preconditions.join(" / ")}
                      </CardDescription>
                    )}
                    {artifactInfo.overview.completion_criteria && (
                      <CardDescription>
                        完了条件: {artifactInfo.overview.completion_criteria}
                      </CardDescription>
                    )}
                  </CardHeader>
                </Card>
              )}
              {reviewStepCount > 0 && (
                <Alert className="border-destructive/40">
                  <AlertTitle>要レビュー {reviewStepCount} 件</AlertTitle>
                  <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <span>機械検証で確認が必要なステップがあります。</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={focusNextReviewStep}
                      className="w-full sm:w-auto"
                    >
                      <Pencil className="h-4 w-4 mr-2" />
                      次の要レビューを編集
                    </Button>
                  </AlertDescription>
                </Alert>
              )}
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={steps.map((s) => s.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-4">
                    {steps.map((step, index) => (
                      <SortableStepCard
                        key={step.id}
                        step={step}
                        index={index}
                        isEditing={editingStepId === step.id}
                        onToggleEdit={() => setEditingStepId(editingStepId === step.id ? null : step.id)}
                        onUpdate={handleUpdateStep}
                        onDelete={handleDeleteStep}
                        onRegenerate={handleRegenerateStep}
                        isRegenerating={regeneratingStepId === step.id}
                        frame={frames?.find((f) => f.id === step.frameId)}
                        review={artifactInfo?.reviewByStepId?.[step.id]}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
              </>
            ) : (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-12">
                  <FileText className="h-16 w-16 text-muted-foreground mb-4" />
                  <h3 className="text-lg font-semibold mb-2 text-foreground">
                    ステップがありません
                  </h3>
                  <p className="text-muted-foreground text-center mb-4">
                    AIでステップを生成ボタンをクリックして、自動で手順を生成しましょう。
                  </p>
                  <Button
                    onClick={handleGenerateSteps}
                    disabled={generateStepsMutation.isPending || !frames || frames.length === 0}
                  >
                    {generateStepsMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    <Wand2 className="h-4 w-4 mr-2" />
                    AIでステップを生成
                  </Button>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* Preview Tab */}
          <TabsContent value="preview" className="space-y-4">
            <div className="grid gap-6 lg:grid-cols-2">
              {/* 元動画 */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Film className="h-5 w-5" />
                    元動画
                  </CardTitle>
                  <CardDescription>
                    アップロードされた画面録画
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {project.videoUrl ? (
                    <div className="relative aspect-video bg-black rounded-lg overflow-hidden">
                      <video
                        src={project.videoUrl}
                        controls
                        className="w-full h-full object-contain"
                        preload="metadata"
                      >
                        お使いのブラウザは動画再生に対応していません。
                      </video>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center aspect-video bg-muted rounded-lg">
                      <Film className="h-12 w-12 text-muted-foreground mb-2" />
                      <p className="text-sm text-muted-foreground">動画がありません</p>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* チュートリアル動画（生成後） */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Play className="h-5 w-5" />
                    チュートリアル動画
                  </CardTitle>
                  <CardDescription>
                    AIが生成した解説動画
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {videoUrl ? (
                    <div className="space-y-4">
                      <div className="relative aspect-video bg-black rounded-lg overflow-hidden">
                        <video
                          src={videoUrl}
                          controls
                          className="w-full h-full object-contain"
                          preload="metadata"
                        >
                          お使いのブラウザは動画再生に対応していません。
                        </video>
                      </div>
                      <div className="flex justify-center">
                        <Button onClick={() => downloadFile(videoUrl, `${project.title}.mp4`)}>
                          <Download className="h-4 w-4 mr-2" />
                          動画をダウンロード
                        </Button>
                      </div>
                    </div>
                  ) : project.status === "completed" && steps && steps.length > 0 ? (
                    <div className="space-y-4">
                      {isGeneratingVideo && videoGenerationProgress ? (
                        /* 動画生成中の進捗表示 */
                        <div className="flex flex-col items-center justify-center aspect-video bg-muted rounded-lg p-6">
                          <Loader2 className="h-12 w-12 text-primary mb-4 animate-spin" />
                          <p className="text-sm font-medium mb-2">
                            {videoGenerationProgress.message}
                          </p>
                          <div className="w-full max-w-xs space-y-2">
                            <Progress value={videoGenerationProgress.progress} className="h-3" />
                            <p className="text-xs text-muted-foreground text-center">
                              {videoGenerationProgress.progress}%
                            </p>
                          </div>
                          <p className="text-xs text-muted-foreground mt-4">
                            しばらくお待ちください...
                          </p>
                        </div>
                      ) : (
                        /* 動画生成ボタン */
                        <div className="flex flex-col items-center justify-center aspect-video bg-muted rounded-lg">
                          <Wand2 className="h-12 w-12 text-muted-foreground mb-2" />
                          <p className="text-sm text-muted-foreground mb-4">
                            動画を生成する準備ができました
                          </p>
                          {/* 音声選択 */}
                          <div className="flex flex-col items-center gap-3 mb-4">
                            <Label className="text-sm text-muted-foreground">ナレーション音声を選択</Label>
                            <select
                              value={selectedVoice}
                              onChange={(e) => setSelectedVoice(e.target.value)}
                              className="px-3 py-2 border rounded-md bg-background text-sm"
                            >
                              {(availableVoices && availableVoices.length > 0
                                ? availableVoices
                                : [
                                    { id: "nova", name: "Nova", description: "女性的で明るい声（推奨）" },
                                  ]
                              ).map((voice) => (
                                <option key={voice.id} value={voice.id}>
                                  {voice.name} - {voice.description}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="flex flex-col gap-1">
                            <label className="text-xs text-muted-foreground" htmlFor="audio-mode-select">
                              音声モード
                            </label>
                            <select
                              id="audio-mode-select"
                              value={audioMode}
                              onChange={(e) =>
                                setAudioMode(e.target.value as typeof audioMode)
                              }
                              className="px-3 py-2 border rounded-md bg-background text-sm"
                            >
                              <option value="auto">自動（録画に音声があれば元音声、なければTTS）</option>
                              <option value="tts">TTSナレーション</option>
                              <option value="original">元録画の音声</option>
                              <option value="mixed">元音声+TTS（実験的）</option>
                              <option value="silent">無音</option>
                            </select>
                          </div>
                          <Button onClick={handleGenerateVideo} disabled={isGeneratingVideo}>
                            {isGeneratingVideo && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                            <Wand2 className="h-4 w-4 mr-2" />
                            動画を生成
                          </Button>
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground text-center">
                        ステップ {steps.length}件の解説動画を生成できます
                      </p>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center aspect-video bg-muted rounded-lg">
                      <Loader2 className="h-12 w-12 text-muted-foreground mb-2" />
                      <p className="text-sm text-muted-foreground">
                        {project.status === "processing" ? "処理中..." : "ステップを生成してください"}
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* スライドプレビュー（ステップをスライドショー形式で表示） */}
            {steps && steps.length > 0 && frames && frames.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Presentation className="h-5 w-5" />
                    スライドプレビュー
                  </CardTitle>
                  <CardDescription>
                    生成されたチュートリアルをスライドショー形式でプレビュー
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col items-center gap-4">
                    <p className="text-sm text-muted-foreground text-center">
                      {steps.length}枚のステップをインタラクティブなスライドショーで確認できます
                    </p>
                    <Button onClick={() => setIsSlidePreviewOpen(true)}>
                      <Presentation className="h-4 w-4 mr-2" />
                      スライドプレビューを開く
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* フレームギャラリー */}
            {frames && frames.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">フレームギャラリー</CardTitle>
                  <CardDescription>
                    抽出されたキーフレーム一覧（{frames.length}枚）
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
                    {frames.slice(0, 12).map((frame, index) => (
                      <div
                        key={frame.id}
                        className="relative aspect-video bg-muted rounded overflow-hidden group cursor-pointer"
                      >
                        <img
                          src={frame.imageUrl}
                          alt={`Frame ${frame.frameNumber}`}
                          className="w-full h-full object-cover"
                        />
                        <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                          <span className="text-white text-xs font-medium">
                            {Math.floor(frame.timestamp / 1000)}秒
                          </span>
                        </div>
                      </div>
                    ))}
                    {frames.length > 12 && (
                      <div className="flex items-center justify-center aspect-video bg-muted rounded text-sm text-muted-foreground">
                        +{frames.length - 12}枚
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* スライドプレビューダイアログ */}
      {steps && frames && (
        <SlidePreview
          steps={steps}
          frames={frames}
          isOpen={isSlidePreviewOpen}
          onClose={() => setIsSlidePreviewOpen(false)}
        />
      )}
    </DashboardLayout>
  );
}
