import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, Image as ImageIcon, FileText, Download, Wand2, Loader2, CheckCircle, XCircle, Clock, RefreshCw, Settings } from "lucide-react";
import { Link, useParams } from "wouter";
import { toast } from "sonner";
import { useState, useEffect } from "react";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export default function ProjectDetail() {
  const params = useParams<{ id: string }>();
  const projectId = parseInt(params.id || "0");
  
  const { data: project, isLoading: projectLoading, refetch: refetchProject } = trpc.project.getById.useQuery({ id: projectId });
  const { data: frames, isLoading: framesLoading, refetch: refetchFrames } = trpc.frame.listByProject.useQuery({ projectId });
  const { data: steps, isLoading: stepsLoading, refetch: refetchSteps } = trpc.step.listByProject.useQuery({ projectId });
  const utils = trpc.useUtils();
  const [progressData, setProgressData] = useState<{ progress: number; message: string; errorMessage?: string | null } | null>(null);

  // 処理中のプロジェクトの進捗をポーリング
  useEffect(() => {
    if (!project || (project.status !== "processing" && project.status !== "failed")) {
      return;
    }

    const interval = setInterval(async () => {
      try {
        const progress = await utils.project.getProgress.fetch({ id: projectId });
        setProgressData({
          progress: progress.progress,
          message: progress.message,
          errorMessage: progress.errorMessage,
        });

        if (progress.status === "completed" || (progress.status === "failed" && progress.errorMessage)) {
          clearInterval(interval);
          refetchProject();
          refetchFrames();
          refetchSteps();
        }
      } catch (error) {
        console.error("Failed to fetch progress:", error);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [project?.status, projectId, utils, refetchProject, refetchFrames, refetchSteps]);
  
  const generateStepsMutation = trpc.step.generate.useMutation();
  const updateStepMutation = trpc.step.update.useMutation();
  const deleteStepMutation = trpc.step.delete.useMutation();
  const retryProjectMutation = trpc.project.retry.useMutation();

  const [editingStepId, setEditingStepId] = useState<number | null>(null);
  const [isRetryDialogOpen, setIsRetryDialogOpen] = useState(false);
  const [retryParams, setRetryParams] = useState({
    threshold: 5.0,
    minInterval: 30,
    maxFrames: 100,
  });

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
      
      // ポーリングで結果を確認
      const pollInterval = setInterval(() => {
        refetchSteps();
      }, 3000);
      
      setTimeout(() => {
        clearInterval(pollInterval);
      }, 60000); // 1分後にポーリング停止
      
    } catch (error) {
      toast.error("ステップの生成に失敗しました");
    }
  };

  const handleUpdateStep = async (stepId: number, data: any) => {
    try {
      await updateStepMutation.mutateAsync({ id: stepId, ...data });
      toast.success("ステップを更新しました");
      refetchSteps();
      setEditingStepId(null);
    } catch (error) {
      toast.error("ステップの更新に失敗しました");
    }
  };

  const handleDeleteStep = async (stepId: number) => {
    if (!confirm("このステップを削除しますか?")) return;
    
    try {
      await deleteStepMutation.mutateAsync({ id: stepId });
      toast.success("ステップを削除しました");
      refetchSteps();
    } catch (error) {
      toast.error("ステップの削除に失敗しました");
    }
  };

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
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/projects">
              <Button variant="ghost" size="icon">
                <ArrowLeft className="h-5 w-5" />
              </Button>
            </Link>
            <div>
              <div className="flex items-center gap-3 mb-2">
                <h1 className="text-3xl font-bold text-foreground">{project.title}</h1>
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
          <div className="flex gap-2">
            <Button variant="outline" disabled>
              <Download className="h-4 w-4 mr-2" />
              スライドをダウンロード
            </Button>
            <Button variant="outline" disabled>
              <Download className="h-4 w-4 mr-2" />
              動画をダウンロード
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
          <TabsList>
            <TabsTrigger value="frames">
              <ImageIcon className="h-4 w-4 mr-2" />
              フレーム ({frames?.length || 0})
            </TabsTrigger>
            <TabsTrigger value="steps">
              <FileText className="h-4 w-4 mr-2" />
              ステップ ({steps?.length || 0})
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
              <div className="space-y-4">
                {steps.map((step, index) => (
                  <Card key={step.id}>
                    <CardHeader>
                      <div className="flex items-start justify-between">
                        <div className="flex gap-4 flex-1">
                          <div className="flex-shrink-0 w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-bold">
                            {index + 1}
                          </div>
                          <div className="flex-1">
                            {editingStepId === step.id ? (
                              <div className="space-y-4">
                                <div>
                                  <Label htmlFor={`title-${step.id}`}>タイトル</Label>
                                  <Input
                                    id={`title-${step.id}`}
                                    defaultValue={step.title}
                                    onBlur={(e) => handleUpdateStep(step.id, { title: e.target.value })}
                                  />
                                </div>
                                <div>
                                  <Label htmlFor={`operation-${step.id}`}>操作</Label>
                                  <Input
                                    id={`operation-${step.id}`}
                                    defaultValue={step.operation}
                                    onBlur={(e) => handleUpdateStep(step.id, { operation: e.target.value })}
                                  />
                                </div>
                                <div>
                                  <Label htmlFor={`description-${step.id}`}>説明</Label>
                                  <Textarea
                                    id={`description-${step.id}`}
                                    defaultValue={step.description}
                                    rows={3}
                                    onBlur={(e) => handleUpdateStep(step.id, { description: e.target.value })}
                                  />
                                </div>
                                <div>
                                  <Label htmlFor={`narration-${step.id}`}>ナレーション</Label>
                                  <Textarea
                                    id={`narration-${step.id}`}
                                    defaultValue={step.narration || ""}
                                    rows={2}
                                    onBlur={(e) => handleUpdateStep(step.id, { narration: e.target.value })}
                                  />
                                </div>
                              </div>
                            ) : (
                              <>
                                <CardTitle>{step.title}</CardTitle>
                                <CardDescription className="mt-2">
                                  <strong>操作:</strong> {step.operation}
                                </CardDescription>
                                <p className="text-sm text-foreground mt-2">{step.description}</p>
                                {step.narration && (
                                  <p className="text-sm text-muted-foreground mt-2 italic">
                                    🎙️ {step.narration}
                                  </p>
                                )}
                              </>
                            )}
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditingStepId(editingStepId === step.id ? null : step.id)}
                          >
                            {editingStepId === step.id ? "完了" : "編集"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDeleteStep(step.id)}
                          >
                            削除
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                  </Card>
                ))}
              </div>
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
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
