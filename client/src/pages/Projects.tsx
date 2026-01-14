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
import { useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { storagePut } from "server/storage";

export default function Projects() {
  const { user } = useAuth();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  
  const { data: projects, isLoading, refetch } = trpc.project.list.useQuery();
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

    setIsUploading(true);

    try {
      // S3に動画をアップロード
      const videoBuffer = await videoFile.arrayBuffer();
      const videoKey = `projects/${user?.id}/videos/${Date.now()}_${videoFile.name}`;
      
      // storagePutはサーバーサイド関数なので、直接呼び出せません
      // 代わりに、ファイルをBase64エンコードしてサーバーに送信する必要があります
      // ここでは簡略化のため、URLを生成する処理をスキップします
      
      toast.error("動画アップロード機能は現在開発中です。サーバーサイドでの実装が必要です。");
      setIsUploading(false);
      return;

      // TODO: 実際の実装では、以下のようにサーバーサイドでアップロードを行う
      // const result = await createProjectMutation.mutateAsync({
      //   title,
      //   description,
      //   videoUrl: uploadedUrl,
      //   videoKey: videoKey,
      // });
      
      // await processVideoMutation.mutateAsync({
      //   projectId: result.projectId,
      //   videoUrl: uploadedUrl,
      // });

    } catch (error) {
      console.error("プロジェクト作成エラー:", error);
      toast.error("プロジェクトの作成に失敗しました");
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
            <Clock className="h-3 w-3" />
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
          <Link href="/projects/new">
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              新規プロジェクト
            </Button>
          </Link>
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
