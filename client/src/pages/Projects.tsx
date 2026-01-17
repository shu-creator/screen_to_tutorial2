import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { Plus, Video, Clock, CheckCircle, XCircle, Loader2, Download, Trash2, RefreshCw, Settings, Search, Filter, Copy, ChevronDown } from "lucide-react";
import { useState, useEffect, useRef, useMemo } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { Progress } from "@/components/ui/progress";

export default function Projects() {
  const { user } = useAuth();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{
    phase: "reading" | "uploading" | "starting";
    progress: number;
    message: string;
  } | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<number | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [isBulkDeleteOpen, setIsBulkDeleteOpen] = useState(false);

  // フィルタリング・検索
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  // 詳細設定（新規プロジェクト用）
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false);
  const [processingParams, setProcessingParams] = useState({
    threshold: 5.0,
    minInterval: 30,
    maxFrames: 100,
  });

  // 削除取り消し用
  const [deletedProject, setDeletedProject] = useState<{ id: number; title: string; timeout: NodeJS.Timeout } | null>(null);
  const undoTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const { data: projects, isLoading, refetch } = trpc.project.list.useQuery();
  const utils = trpc.useUtils();
  const [pollingProjectIds, setPollingProjectIds] = useState<Set<number>>(new Set());
  const [progressData, setProgressData] = useState<Map<number, { progress: number; message: string; errorMessage?: string | null }>>(new Map());

  // フィルタリングされたプロジェクト
  const filteredProjects = useMemo(() => {
    if (!projects) return [];
    return projects.filter(p => {
      // ステータスフィルター
      if (statusFilter !== "all" && p.status !== statusFilter) return false;
      // 検索クエリ
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        return p.title.toLowerCase().includes(query) ||
               (p.description?.toLowerCase().includes(query) ?? false);
      }
      return true;
    });
  }, [projects, statusFilter, searchQuery]);

  // 処理中または失敗したプロジェクトを自動検出してポーリング開始
  useEffect(() => {
    if (projects) {
      const processingIds = new Set(
        projects
          .filter(p => p.status === "processing" || p.status === "failed")
          .map(p => p.id)
      );
      setPollingProjectIds(processingIds);
    }
  }, [projects]);

  // ポーリング処理（1秒間隔）
  useEffect(() => {
    if (pollingProjectIds.size === 0) return;

    const interval = setInterval(async () => {
      const projectIdArray = Array.from(pollingProjectIds);
      for (const projectId of projectIdArray) {
        try {
          const progress = await utils.project.getProgress.fetch({ id: projectId });
          setProgressData(prev => new Map(prev).set(projectId, {
            progress: progress.progress,
            message: progress.message,
            errorMessage: progress.errorMessage,
          }));

          // 処理完了または失敗した場合はポーリング停止（失敗時はエラーメッセージを取得後）
          if (progress.status === "completed") {
            setPollingProjectIds(prev => {
              const next = new Set(prev);
              next.delete(projectId);
              return next;
            });
            refetch(); // プロジェクト一覧を更新
          } else if (progress.status === "failed" && progress.errorMessage) {
            // 失敗時はエラーメッセージを取得したらポーリング停止
            setPollingProjectIds(prev => {
              const next = new Set(prev);
              next.delete(projectId);
              return next;
            });
            refetch();
          }
        } catch (error) {
          console.error(`Failed to fetch progress for project ${projectId}:`, error);
        }
      }
    }, 1000); // 1秒間隔

    return () => clearInterval(interval);
  }, [pollingProjectIds, refetch]);
  const createProjectMutation = trpc.project.create.useMutation();
  const processVideoMutation = trpc.project.processVideo.useMutation();
  const deleteProjectMutation = trpc.project.delete.useMutation();
  const bulkDeleteMutation = trpc.project.bulkDelete.useMutation();
  const retryProjectMutation = trpc.project.retry.useMutation();
  const duplicateProjectMutation = trpc.project.duplicate.useMutation();

  // エラーログエクスポート
  const handleExportErrorLogs = async (format: "json" | "csv") => {
    try {
      const result = await utils.project.exportErrorLogs.fetch({ format });
      const blob = new Blob([result.data], { type: format === "json" ? "application/json" : "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `error-logs.${format}`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`エラーログを${format.toUpperCase()}形式でエクスポートしました`);
    } catch (error) {
      toast.error("エラーログのエクスポートに失敗しました");
    }
  };

  // 失敗したプロジェクトがあるかチェック
  const hasFailedProjects = projects?.some(p => p.status === "failed") ?? false;

  // プロジェクト削除
  const handleDeleteProject = async () => {
    if (!deleteTargetId) return;

    setIsDeleting(true);
    try {
      await deleteProjectMutation.mutateAsync({ id: deleteTargetId });
      toast.success("プロジェクトを削除しました");
      refetch();
    } catch (error) {
      console.error("プロジェクト削除エラー:", error);
      toast.error("プロジェクトの削除に失敗しました");
    } finally {
      setIsDeleting(false);
      setDeleteTargetId(null);
    }
  };

  // 一括削除
  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;

    setIsDeleting(true);
    try {
      await bulkDeleteMutation.mutateAsync({ ids: Array.from(selectedIds) });
      toast.success(`${selectedIds.size}件のプロジェクトを削除しました`);
      setSelectedIds(new Set());
      refetch();
    } catch (error) {
      console.error("一括削除エラー:", error);
      toast.error("プロジェクトの削除に失敗しました");
    } finally {
      setIsDeleting(false);
      setIsBulkDeleteOpen(false);
    }
  };

  // 再試行
  const handleRetry = async (projectId: number) => {
    try {
      await retryProjectMutation.mutateAsync({ projectId });
      toast.success("再処理を開始しました");
      refetch();
    } catch (error) {
      console.error("再試行エラー:", error);
      toast.error("再処理の開始に失敗しました");
    }
  };

  // プロジェクト複製
  const handleDuplicate = async (projectId: number) => {
    try {
      const result = await duplicateProjectMutation.mutateAsync({ projectId });
      toast.success("プロジェクトを複製しました");
      refetch();
    } catch (error) {
      console.error("複製エラー:", error);
      toast.error("プロジェクトの複製に失敗しました");
    }
  };

  // 削除取り消し機能付き削除
  const handleDeleteWithUndo = async (projectId: number, projectTitle: string) => {
    // 既存の取り消しタイマーをクリア
    if (undoTimeoutRef.current) {
      clearTimeout(undoTimeoutRef.current);
    }

    setDeletedProject({ id: projectId, title: projectTitle, timeout: setTimeout(() => {}, 0) });

    // 30秒後に実際に削除
    const timeout = setTimeout(async () => {
      try {
        await deleteProjectMutation.mutateAsync({ id: projectId });
        setDeletedProject(null);
        refetch();
      } catch (error) {
        console.error("削除エラー:", error);
        toast.error("プロジェクトの削除に失敗しました");
      }
    }, 30000);

    undoTimeoutRef.current = timeout;
    setDeletedProject({ id: projectId, title: projectTitle, timeout });

    toast.info(`「${projectTitle}」を削除します`, {
      description: "30秒以内に取り消せます",
      action: {
        label: "元に戻す",
        onClick: () => {
          if (undoTimeoutRef.current) {
            clearTimeout(undoTimeoutRef.current);
            undoTimeoutRef.current = null;
          }
          setDeletedProject(null);
          toast.success("削除を取り消しました");
        },
      },
      duration: 30000,
    });
  };

  // チェックボックスの切り替え
  const toggleSelect = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // 全選択/全解除
  const toggleSelectAll = () => {
    if (!projects) return;
    if (selectedIds.size === projects.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(projects.map(p => p.id)));
    }
  };

  const handleCreateProject = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const title = formData.get("title") as string;
    const description = formData.get("description") as string;
    const videoFile = formData.get("video") as File;

    if (!videoFile) {
      toast.error("動画ファイルを選択してください");
      return;
    }

    // ファイルサイズチェック (500MB制限)
    const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
    if (videoFile.size > MAX_FILE_SIZE) {
      toast.error("ファイルサイズは500MB以下にしてください");
      return;
    }

    // ファイル形式チェック
    const allowedTypes = ["video/mp4", "video/quicktime", "video/x-msvideo"];
    if (!allowedTypes.includes(videoFile.type)) {
      toast.error("MP4、MOV、AVI形式の動画ファイルのみアップロード可能です");
      return;
    }

    setIsUploading(true);
    setUploadProgress({ phase: "reading", progress: 0, message: "ファイルを読み込み中..." });

    try {
      // ファイルをBase64エンコード（FileReaderを使用してバイナリ安全に）
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();

        // 読み込み進捗を追跡
        reader.onprogress = (event) => {
          if (event.lengthComputable) {
            const progress = Math.round((event.loaded / event.total) * 100);
            setUploadProgress({
              phase: "reading",
              progress,
              message: `ファイルを読み込み中... ${progress}%`,
            });
          }
        };

        reader.onload = () => {
          const result = reader.result as string;
          // "data:video/mp4;base64,..." から base64部分のみを抽出
          const base64Data = result.split(",")[1];
          resolve(base64Data);
        };
        reader.onerror = () => reject(new Error("ファイルの読み込みに失敗しました"));
        reader.readAsDataURL(videoFile);
      });

      // アップロード中フェーズ
      setUploadProgress({ phase: "uploading", progress: 0, message: "サーバーにアップロード中..." });

      // サーバーにアップロード（サーバー側でストレージにアップロード）
      const result = await createProjectMutation.mutateAsync({
        title,
        description: description || undefined,
        videoBase64: base64,
        fileName: videoFile.name,
        contentType: videoFile.type || "video/mp4",
      });

      // 処理開始フェーズ
      setUploadProgress({ phase: "starting", progress: 100, message: "処理を開始しています..." });

      toast.success("プロジェクトを作成しました");
      setIsDialogOpen(false);

      // 動画処理を開始（詳細設定のパラメータを使用）
      await processVideoMutation.mutateAsync({
        projectId: result.projectId,
        videoUrl: result.videoUrl,
        threshold: processingParams.threshold,
        minInterval: processingParams.minInterval,
        maxFrames: processingParams.maxFrames,
      });

      toast.success("動画処理を開始しました");
      refetch();

    } catch (error) {
      console.error("プロジェクト作成エラー:", error);
      // エラーメッセージの詳細を表示
      let errorMessage = "プロジェクトの作成に失敗しました";
      if (error instanceof Error) {
        if (error.message.includes("request entity too large") || error.message.includes("413")) {
          errorMessage = "ファイルサイズが大きすぎます。サーバー制限を超えています。";
        } else if (error.message.includes("network") || error.message.includes("fetch")) {
          errorMessage = "ネットワークエラーが発生しました。接続を確認してください。";
        } else if (error.message) {
          errorMessage = `エラー: ${error.message}`;
        }
      }
      toast.error(errorMessage);
    } finally {
      setIsUploading(false);
      setUploadProgress(null);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "uploading":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs bg-blue-100 text-blue-700">
            <Loader2 className="h-3 w-3 animate-spin" />
            アップロード中
          </span>
        );
      case "processing":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs bg-yellow-100 text-yellow-700">
            <Loader2 className="h-3 w-3 animate-spin" />
            処理中
          </span>
        );
      case "completed":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs bg-green-100 text-green-700">
            <CheckCircle className="h-3 w-3" />
            完了
          </span>
        );
      case "failed":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs bg-red-100 text-red-700">
            <XCircle className="h-3 w-3" />
            失敗
          </span>
        );
      default:
        return null;
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-foreground">プロジェクト</h1>
            <p className="text-muted-foreground mt-1">
              動画から自動でチュートリアルを生成します
            </p>
          </div>
          <div className="flex gap-2 items-center">
            {selectedIds.size > 0 && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setIsBulkDeleteOpen(true)}
              >
                <Trash2 className="h-4 w-4 mr-1" />
                {selectedIds.size}件削除
              </Button>
            )}
            {projects && projects.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={toggleSelectAll}
              >
                {selectedIds.size === projects.length ? "全解除" : "全選択"}
              </Button>
            )}
            {hasFailedProjects && (
              <div className="flex gap-1">
                <Button variant="outline" size="sm" onClick={() => handleExportErrorLogs("json")}>
                  <Download className="h-4 w-4 mr-1" />
                  JSON
                </Button>
                <Button variant="outline" size="sm" onClick={() => handleExportErrorLogs("csv")}>
                  <Download className="h-4 w-4 mr-1" />
                  CSV
                </Button>
              </div>
            )}
            <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="h-4 w-4 mr-2" />
                  新規プロジェクト
                </Button>
              </DialogTrigger>
            <DialogContent className="sm:max-w-[525px]">
              <form onSubmit={handleCreateProject}>
                <DialogHeader>
                  <DialogTitle>新規プロジェクト作成</DialogTitle>
                  <DialogDescription>
                    動画ファイルをアップロードして、新しいチュートリアルプロジェクトを作成します。
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="grid gap-2">
                    <Label htmlFor="title">タイトル</Label>
                    <Input
                      id="title"
                      name="title"
                      placeholder="例: Excelの基本操作"
                      required
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="description">説明（任意）</Label>
                    <Textarea
                      id="description"
                      name="description"
                      placeholder="このチュートリアルの内容を簡単に説明してください"
                      rows={3}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="video">動画ファイル</Label>
                    <Input
                      id="video"
                      name="video"
                      type="file"
                      accept="video/mp4,video/quicktime,video/x-msvideo"
                      required
                    />
                    <p className="text-xs text-muted-foreground">
                      MP4、MOV、AVI形式（最大500MB）
                    </p>
                  </div>

                  {/* 詳細設定 */}
                  <Collapsible open={advancedSettingsOpen} onOpenChange={setAdvancedSettingsOpen}>
                    <CollapsibleTrigger asChild>
                      <Button variant="ghost" type="button" className="w-full justify-between">
                        <span className="flex items-center gap-2">
                          <Settings className="h-4 w-4" />
                          詳細設定
                        </span>
                        <ChevronDown className={`h-4 w-4 transition-transform ${advancedSettingsOpen ? "rotate-180" : ""}`} />
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="space-y-4 pt-2">
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <Label className="text-sm">差分検知の閾値</Label>
                          <span className="text-sm text-muted-foreground">{processingParams.threshold.toFixed(1)}</span>
                        </div>
                        <Slider
                          value={[processingParams.threshold]}
                          onValueChange={([value]) => setProcessingParams(prev => ({ ...prev, threshold: value }))}
                          min={1}
                          max={20}
                          step={0.5}
                        />
                        <p className="text-xs text-muted-foreground">
                          低い値：より多くのフレームを抽出 / 高い値：大きな変化のみ抽出
                        </p>
                      </div>
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <Label className="text-sm">最小フレーム間隔</Label>
                          <span className="text-sm text-muted-foreground">{processingParams.minInterval}フレーム</span>
                        </div>
                        <Slider
                          value={[processingParams.minInterval]}
                          onValueChange={([value]) => setProcessingParams(prev => ({ ...prev, minInterval: value }))}
                          min={10}
                          max={120}
                          step={5}
                        />
                        <p className="text-xs text-muted-foreground">
                          連続するフレーム間の最小間隔
                        </p>
                      </div>
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <Label className="text-sm">最大フレーム数</Label>
                          <span className="text-sm text-muted-foreground">{processingParams.maxFrames}枚</span>
                        </div>
                        <Slider
                          value={[processingParams.maxFrames]}
                          onValueChange={([value]) => setProcessingParams(prev => ({ ...prev, maxFrames: value }))}
                          min={10}
                          max={200}
                          step={10}
                        />
                        <p className="text-xs text-muted-foreground">
                          抽出するフレームの最大数
                        </p>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                </div>
                <DialogFooter className="flex-col gap-3">
                  {uploadProgress && (
                    <div className="w-full space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">{uploadProgress.message}</span>
                        {uploadProgress.phase === "reading" && (
                          <span className="font-medium">{uploadProgress.progress}%</span>
                        )}
                      </div>
                      <Progress
                        value={uploadProgress.phase === "reading" ? uploadProgress.progress : 100}
                        className="h-2"
                      />
                    </div>
                  )}
                  <Button type="submit" disabled={isUploading} className="w-full sm:w-auto">
                    {isUploading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    {isUploading ? (uploadProgress?.phase === "reading" ? "読み込み中..." : uploadProgress?.phase === "uploading" ? "アップロード中..." : "処理開始中...") : "作成"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
          </div>
        </div>

        {/* フィルタリング・検索 */}
        {projects && projects.length > 0 && (
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="プロジェクトを検索..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-full sm:w-[180px]">
                <Filter className="h-4 w-4 mr-2" />
                <SelectValue placeholder="ステータス" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">すべて</SelectItem>
                <SelectItem value="processing">処理中</SelectItem>
                <SelectItem value="completed">完了</SelectItem>
                <SelectItem value="failed">失敗</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        {isLoading ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[...Array(3)].map((_, i) => (
              <Card key={i} className="animate-pulse">
                <CardHeader>
                  <div className="h-6 bg-muted rounded w-3/4 mb-2" />
                  <div className="h-4 bg-muted rounded w-1/2" />
                </CardHeader>
                <CardContent>
                  <div className="h-4 bg-muted rounded w-full" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : filteredProjects && filteredProjects.length > 0 ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filteredProjects.map((project) => (
              <Card key={project.id} className="hover:shadow-lg transition-shadow h-full relative group">
                <Link href={`/projects/${project.id}`} className="block">
                  <CardHeader>
                    <div className="flex items-start justify-between">
                      <Video className="h-10 w-10 text-primary" />
                      {getStatusBadge(project.status)}
                    </div>
                    <CardTitle className="mt-4">{project.title}</CardTitle>
                    <CardDescription>
                      {project.description || "説明なし"}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {project.status === "processing" && progressData.has(project.id) && (
                      <div className="space-y-2 mb-3">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">
                            {progressData.get(project.id)?.message || "処理中..."}
                          </span>
                          <span className="font-medium">
                            {progressData.get(project.id)?.progress || 0}%
                          </span>
                        </div>
                        <Progress value={progressData.get(project.id)?.progress || 0} className="h-2" />
                      </div>
                    )}
                    {project.status === "failed" && progressData.has(project.id) && progressData.get(project.id)?.errorMessage && (
                      <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-md">
                        <p className="text-xs text-red-700 font-medium mb-1">エラー詳細:</p>
                        <p className="text-xs text-red-600">
                          {progressData.get(project.id)?.errorMessage}
                        </p>
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground">
                      作成日: {new Date(project.createdAt).toLocaleDateString("ja-JP")}
                    </p>
                  </CardContent>
                </Link>
                <div
                  className="absolute top-2 left-2 z-10"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                >
                  <Checkbox
                    checked={selectedIds.has(project.id)}
                    onCheckedChange={() => toggleSelect(project.id)}
                    className="bg-background border-2"
                  />
                </div>
                {/* アクションボタン群 */}
                <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {/* 失敗時のみ再試行ボタン表示 */}
                  {project.status === "failed" && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-primary"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleRetry(project.id);
                      }}
                      disabled={retryProjectMutation.isPending}
                      title="再試行"
                    >
                      <RefreshCw className="h-4 w-4" />
                    </Button>
                  )}
                  {/* 複製ボタン */}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-primary"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleDuplicate(project.id);
                    }}
                    disabled={duplicateProjectMutation.isPending}
                    title="複製"
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                  {/* 削除ボタン（取り消し機能付き） */}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleDeleteWithUndo(project.id, project.title);
                    }}
                    title="削除"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        ) : projects && projects.length > 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Search className="h-16 w-16 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2 text-foreground">
                検索結果がありません
              </h3>
              <p className="text-muted-foreground text-center mb-4">
                フィルター条件を変更するか、検索キーワードを見直してください。
              </p>
              <Button variant="outline" onClick={() => { setSearchQuery(""); setStatusFilter("all"); }}>
                フィルターをリセット
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Video className="h-16 w-16 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2 text-foreground">
                プロジェクトがありません
              </h3>
              <p className="text-muted-foreground text-center mb-4">
                新規プロジェクトを作成して、最初のチュートリアルを生成しましょう。
              </p>
              <Button onClick={() => setIsDialogOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                新規プロジェクト
              </Button>
            </CardContent>
          </Card>
        )}
      </div>

      {/* 削除確認ダイアログ */}
      <AlertDialog open={deleteTargetId !== null} onOpenChange={(open) => !open && setDeleteTargetId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>プロジェクトを削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              この操作は取り消せません。プロジェクトに関連するすべてのデータ（フレーム、ステップなど）が削除されます。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteProject}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              削除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 一括削除確認ダイアログ */}
      <AlertDialog open={isBulkDeleteOpen} onOpenChange={setIsBulkDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{selectedIds.size}件のプロジェクトを削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              この操作は取り消せません。選択したプロジェクトとその関連データがすべて削除されます。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {selectedIds.size}件削除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardLayout>
  );
}
