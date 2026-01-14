import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { getLoginUrl } from "@/const";
import { Video, Wand2, FileText, Download, ArrowRight } from "lucide-react";
import { Link } from "wouter";

export default function Home() {
  const { isAuthenticated, loading } = useAuth();

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-blue-50 via-white to-indigo-50">
      {/* Header */}
      <header className="border-b bg-white/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Video className="h-8 w-8 text-primary" />
            <h1 className="text-2xl font-bold text-foreground">TutorialGen</h1>
          </div>
          <div className="flex items-center gap-4">
            {loading ? (
              <div className="h-10 w-24 bg-muted animate-pulse rounded-md" />
            ) : isAuthenticated ? (
              <Link href="/projects">
                <Button>ダッシュボード</Button>
              </Link>
            ) : (
              <a href={getLoginUrl()}>
                <Button>ログイン</Button>
              </a>
            )}
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <main className="flex-1">
        <section className="container mx-auto px-4 py-20 text-center">
          <div className="max-w-4xl mx-auto space-y-8">
            <h2 className="text-5xl font-bold text-foreground leading-tight">
              画面録画から
              <br />
              <span className="text-primary">説明動画を自動生成</span>
            </h2>
            <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
              操作動画をアップロードするだけで、AIが自動で手順を解析。
              <br />
              スライドと音声付きの解説動画を数分で作成できます。
            </p>
            <div className="flex gap-4 justify-center">
              {isAuthenticated ? (
                <Link href="/projects">
                  <Button size="lg" className="text-lg px-8">
                    今すぐ始める
                    <ArrowRight className="ml-2 h-5 w-5" />
                  </Button>
                </Link>
              ) : (
                <a href={getLoginUrl()}>
                  <Button size="lg" className="text-lg px-8">
                    無料で始める
                    <ArrowRight className="ml-2 h-5 w-5" />
                  </Button>
                </a>
              )}
            </div>
          </div>
        </section>

        {/* Features Section */}
        <section className="container mx-auto px-4 py-20">
          <h3 className="text-3xl font-bold text-center mb-12 text-foreground">
            主な機能
          </h3>
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8 max-w-6xl mx-auto">
            <FeatureCard
              icon={<Video className="h-10 w-10 text-primary" />}
              title="動画アップロード"
              description="MP4/MOV形式の画面録画をドラッグ&ドロップで簡単アップロード"
            />
            <FeatureCard
              icon={<Wand2 className="h-10 w-10 text-primary" />}
              title="AI自動解析"
              description="画面の変化を自動検知し、重要な操作手順をキーフレームとして抽出"
            />
            <FeatureCard
              icon={<FileText className="h-10 w-10 text-primary" />}
              title="スライド生成"
              description="抽出された手順から、PowerPoint形式のスライドを自動作成"
            />
            <FeatureCard
              icon={<Download className="h-10 w-10 text-primary" />}
              title="動画出力"
              description="音声ナレーション付きの完成した解説動画をMP4形式でダウンロード"
            />
          </div>
        </section>

        {/* How It Works Section */}
        <section className="bg-white py-20">
          <div className="container mx-auto px-4">
            <h3 className="text-3xl font-bold text-center mb-12 text-foreground">
              使い方
            </h3>
            <div className="max-w-4xl mx-auto space-y-8">
              <StepCard
                number={1}
                title="動画をアップロード"
                description="パソコンの操作を録画した動画ファイルをアップロードします。"
              />
              <StepCard
                number={2}
                title="自動解析を実行"
                description="AIが画面の変化を検知し、重要な手順を自動で抽出します。"
              />
              <StepCard
                number={3}
                title="内容を編集"
                description="抽出された手順のテキストや順序を自由に編集できます。"
              />
              <StepCard
                number={4}
                title="エクスポート"
                description="スライドや音声付き動画として、完成したチュートリアルをダウンロードします。"
              />
            </div>
          </div>
        </section>

        {/* CTA Section */}
        <section className="container mx-auto px-4 py-20 text-center">
          <div className="max-w-2xl mx-auto space-y-6">
            <h3 className="text-3xl font-bold text-foreground">
              今すぐ始めましょう
            </h3>
            <p className="text-lg text-muted-foreground">
              面倒な手作業から解放され、効率的にチュートリアルを作成できます。
            </p>
            {isAuthenticated ? (
              <Link href="/projects">
                <Button size="lg" className="text-lg px-8">
                  ダッシュボードへ
                  <ArrowRight className="ml-2 h-5 w-5" />
                </Button>
              </Link>
            ) : (
              <a href={getLoginUrl()}>
                <Button size="lg" className="text-lg px-8">
                  無料で始める
                  <ArrowRight className="ml-2 h-5 w-5" />
                </Button>
              </a>
            )}
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t bg-white py-8">
        <div className="container mx-auto px-4 text-center text-sm text-muted-foreground">
          <p>&copy; 2026 TutorialGen. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="bg-white p-6 rounded-lg border border-border shadow-sm hover:shadow-md transition-shadow">
      <div className="mb-4">{icon}</div>
      <h4 className="text-lg font-semibold mb-2 text-foreground">{title}</h4>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function StepCard({
  number,
  title,
  description,
}: {
  number: number;
  title: string;
  description: string;
}) {
  return (
    <div className="flex gap-6 items-start">
      <div className="flex-shrink-0 w-12 h-12 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xl font-bold">
        {number}
      </div>
      <div className="flex-1">
        <h4 className="text-xl font-semibold mb-2 text-foreground">{title}</h4>
        <p className="text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}
