import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, Upload, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { Link, useLocation } from "wouter";
import { toast } from "sonner";
import { useState, useRef } from "react";

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
const ALLOWED_TYPES = ["video/mp4", "video/quicktime", "video/x-msvideo"];

export default function NewProject() {
  const [, setLocation] = useLocation();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<"idle" | "uploading" | "processing" | "success" | "error">("idle");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const createProjectMutation = trpc.project.create.useMutation();
  const uploadVideoMutation = trpc.project.uploadVideo.useMutation();

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // ファイルタイプチェック
    if (!ALLOWED_TYPES.includes(file.type)) {
      toast.error("MP4、MOV、AVIファイルのみアップロード可能です");
      return;
    }

    // ファイルサイズチェック
    if (file.size > MAX_FILE_SIZE) {
      toast.error(`ファイルサイズは${MAX_FILE_SIZE / 1024 / 1024}MB以下にしてください`);
      return;
    }

    setVideoFile(file);
    setUploadStatus("idle");
  };

  const handleUpload = async () => {
    if (!title.trim()) {
      toast.error("タイトルを入力してください");
      return;
    }

    if (!videoFile) {
      toast.error("動画ファイルを選択してください");
      return;
    }

    setIsUploading(true);
    setUploadStatus("uploading");
    setUploadProgress(0);

    try {
      // ファイルをBase64に変換
      const reader = new FileReader();
      reader.onprogress = (e) => {
        if (e.lengthComputable) {
          const progress = Math.round((e.loaded / e.total) * 50); // 0-50%: ファイル読み込み
          setUploadProgress(progress);
        }
      };

      const base64Data = await new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          const result = reader.result as string;
          const base64 = result.split(",")[1]; // "data:video/mp4;base64," を除去
          resolve(base64 || "");
        };
        reader.onerror = reject;
        reader.readAsDataURL(videoFile);
      });

      setUploadProgress(50); // ファイル読み込み完了

      // サーバーにアップロード
      const result = await uploadVideoMutation.mutateAsync({
        title,
        description,
        fileName: videoFile.name,
        fileData: base64Data,
        mimeType: videoFile.type,
      });

      setUploadProgress(100);
      setUploadStatus("success");
      toast.success("動画のアップロードが完了しました");

      // プロジェクト詳細ページに遷移
      setTimeout(() => {
        setLocation(`/projects/${result.projectId}`);
      }, 1000);
    } catch (error) {
      console.error("Upload error:", error);
      setUploadStatus("error");
      toast.error("アップロードに失敗しました");
    } finally {
      setIsUploading(false);
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + " " + sizes[i];
  };

  return (
    <DashboardLayout>
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-4">
          <Link href="/projects">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <div>
            <h1 className="text-3xl font-bold text-foreground">新規プロジェクト</h1>
            <p className="text-muted-foreground mt-1">動画をアップロードして、解説動画を作成しましょう</p>
          </div>
        </div>

        {/* Form */}
        <Card>
          <CardHeader>
            <CardTitle>プロジェクト情報</CardTitle>
            <CardDescription>タイトルと説明を入力してください</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Title */}
            <div className="space-y-2">
              <Label htmlFor="title">タイトル *</Label>
              <Input
                id="title"
                placeholder="例: Excelの基本操作"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={isUploading}
              />
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label htmlFor="description">説明（任意）</Label>
              <Textarea
                id="description"
                placeholder="このチュートリアルの内容を簡単に説明してください"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                disabled={isUploading}
              />
            </div>

            {/* File Upload */}
            <div className="space-y-2">
              <Label>動画ファイル *</Label>
              <div
                className="border-2 border-dashed rounded-lg p-8 text-center cursor-pointer hover:border-primary transition-colors"
                onClick={() => !isUploading && fileInputRef.current?.click()}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/mp4,video/quicktime,video/x-msvideo"
                  onChange={handleFileSelect}
                  className="hidden"
                  disabled={isUploading}
                />
                {videoFile ? (
                  <div className="space-y-2">
                    <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto" />
                    <p className="font-medium text-foreground">{videoFile.name}</p>
                    <p className="text-sm text-muted-foreground">{formatFileSize(videoFile.size)}</p>
                    {!isUploading && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          setVideoFile(null);
                          if (fileInputRef.current) {
                            fileInputRef.current.value = "";
                          }
                        }}
                      >
                        別のファイルを選択
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Upload className="h-12 w-12 text-muted-foreground mx-auto" />
                    <p className="font-medium text-foreground">クリックして動画を選択</p>
                    <p className="text-sm text-muted-foreground">
                      MP4、MOV、AVI形式 / 最大{MAX_FILE_SIZE / 1024 / 1024}MB
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Upload Progress */}
            {isUploading && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    {uploadStatus === "uploading" && "アップロード中..."}
                    {uploadStatus === "processing" && "処理中..."}
                  </span>
                  <span className="font-medium text-foreground">{uploadProgress}%</span>
                </div>
                <Progress value={uploadProgress} />
              </div>
            )}

            {/* Status Messages */}
            {uploadStatus === "success" && (
              <div className="flex items-center gap-2 text-green-600 bg-green-50 p-3 rounded-lg">
                <CheckCircle2 className="h-5 w-5" />
                <span className="text-sm font-medium">アップロードが完了しました</span>
              </div>
            )}

            {uploadStatus === "error" && (
              <div className="flex items-center gap-2 text-red-600 bg-red-50 p-3 rounded-lg">
                <AlertCircle className="h-5 w-5" />
                <span className="text-sm font-medium">アップロードに失敗しました。もう一度お試しください。</span>
              </div>
            )}

            {/* Submit Button */}
            <div className="flex gap-3 pt-4">
              <Link href="/projects" className="flex-1">
                <Button variant="outline" className="w-full" disabled={isUploading}>
                  キャンセル
                </Button>
              </Link>
              <Button
                onClick={handleUpload}
                disabled={!title.trim() || !videoFile || isUploading}
                className="flex-1"
              >
                {isUploading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {isUploading ? "アップロード中..." : "アップロード開始"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
