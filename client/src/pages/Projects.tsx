import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { Plus, Video, Clock, CheckCircle, XCircle, Loader2 } from "lucide-react";
import { useState, useEffect } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { Progress } from "@/components/ui/progress";

export default function Projects() {
  const { user } = useAuth();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  
  const { data: projects, isLoading, refetch } = trpc.project.list.useQuery();
  const utils = trpc.useUtils();
  const [pollingProjectIds, setPollingProjectIds] = useState<Set<number>>(new Set());
  const [progressData, setProgressData] = useState<Map<number, { progress: number; message: string }>>(new Map());

  // 処理中のプロジェクトを自動検出してポーリング開始
  useEffect(() => {
    if (projects) {
      const processingIds = new Set(
        projects
          .filter(p => p.status === "processing")
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
          }));

          // 処理完了または失敗した場合はポーリング停止
          if (progress.status === "completed" || progress.status === "failed") {
            setPollingProjectIds(prev => {
              const next = new Set(prev);
              next.delete(projectId);
              return next;
            });
            refetch(); // プロジェクト一覧を更新
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

    try {
      // ファイルをBase64エンコード
      const arrayBuffer = await videoFile.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(arrayBuffer).reduce(
          (data, byte) => data + String.fromCharCode(byte),
          ""
        )
      );

      // サーバーにアップロード（サーバー側でストレージにアップロード）
      const result = await createProjectMutation.mutateAsync({
        title,
        description: description || undefined,
        videoBase64: base64,
        fileName: videoFile.name,
        contentType: videoFile.type || "video/mp4",
      });

      toast.success("プロジェクトを作成しました");
      setIsDialogOpen(false);

      // 動画処理を開始
      await processVideoMutation.mutateAsync({
        projectId: result.projectId,
        videoUrl: result.videoUrl,
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
                </div>
                <DialogFooter>
                  <Button type="submit" disabled={isUploading}>
                    {isUploading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    作成
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>

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
        ) : projects && projects.length > 0 ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => (
              <Link key={project.id} href={`/projects/${project.id}`}>
                <Card className="hover:shadow-lg transition-shadow cursor-pointer h-full">
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
                    <p className="text-xs text-muted-foreground">
                      作成日: {new Date(project.createdAt).toLocaleDateString("ja-JP")}
                    </p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
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
    </DashboardLayout>
  );
}
