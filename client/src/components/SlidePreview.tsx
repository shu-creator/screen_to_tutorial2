import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { ChevronLeft, ChevronRight, X, Maximize2, Minimize2, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useState, useRef } from "react";

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

interface SlidePreviewProps {
  steps: StepData[];
  frames: FrameData[];
  isOpen: boolean;
  onClose: () => void;
  initialSlide?: number;
}

export function SlidePreview({
  steps,
  frames,
  isOpen,
  onClose,
  initialSlide = 0,
}: SlidePreviewProps) {
  const [currentSlide, setCurrentSlide] = useState(initialSlide);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [autoPlay, setAutoPlay] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Reset slide when opening
  useEffect(() => {
    if (isOpen) {
      setCurrentSlide(initialSlide);
      setIsPlaying(false);
    }
  }, [isOpen, initialSlide]);

  const currentStep = steps[currentSlide];
  const currentFrame = frames.find((f) => f.id === currentStep?.frameId);

  // Auto-play audio when slide changes
  useEffect(() => {
    if (autoPlay && currentStep?.audioUrl && audioRef.current) {
      audioRef.current.play().catch(() => {
        // Auto-play may be blocked by browser
        setIsPlaying(false);
      });
    }
  }, [currentSlide, autoPlay, currentStep?.audioUrl]);

  // Handle audio end - auto advance if auto-play is enabled
  const handleAudioEnded = useCallback(() => {
    setIsPlaying(false);
    if (autoPlay && currentSlide < steps.length - 1) {
      setCurrentSlide((prev) => prev + 1);
    }
  }, [autoPlay, currentSlide, steps.length]);

  const togglePlayPause = () => {
    if (!audioRef.current || !currentStep?.audioUrl) return;

    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play().then(() => {
        setIsPlaying(true);
      }).catch(() => {
        setIsPlaying(false);
      });
    }
  };

  const goToNext = useCallback(() => {
    if (currentSlide < steps.length - 1) {
      setCurrentSlide((prev) => prev + 1);
    }
  }, [currentSlide, steps.length]);

  const goToPrev = useCallback(() => {
    if (currentSlide > 0) {
      setCurrentSlide((prev) => prev - 1);
    }
  }, [currentSlide]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        goToNext();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        goToPrev();
      } else if (e.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, goToNext, goToPrev, onClose]);

  const toggleFullscreen = async () => {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
      setIsFullscreen(true);
    } else {
      await document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  // Listen for fullscreen changes
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  if (!currentStep) return null;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[95vw] w-full max-h-[95vh] h-full p-0 gap-0">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b bg-background">
          <div className="flex items-center gap-4">
            <span className="text-sm text-muted-foreground">
              {currentSlide + 1} / {steps.length}
            </span>
            <h2 className="font-semibold truncate">{currentStep.title}</h2>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant={autoPlay ? "default" : "ghost"}
              size="sm"
              onClick={() => setAutoPlay(!autoPlay)}
              title={autoPlay ? "自動再生オフ" : "自動再生オン"}
              className="gap-1"
            >
              <Volume2 className="h-4 w-4" />
              <span className="hidden sm:inline">
                {autoPlay ? "自動再生オン" : "自動再生オフ"}
              </span>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleFullscreen}
              title={isFullscreen ? "フルスクリーン解除" : "フルスクリーン"}
            >
              {isFullscreen ? (
                <Minimize2 className="h-4 w-4" />
              ) : (
                <Maximize2 className="h-4 w-4" />
              )}
            </Button>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Main Content */}
        <div className="flex-1 flex overflow-hidden">
          {/* Slide Content */}
          <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
            {/* Image Section */}
            <div className="flex-1 flex items-center justify-center bg-black p-4 min-h-[300px] lg:min-h-0">
              {currentFrame ? (
                <img
                  src={currentFrame.imageUrl}
                  alt={`ステップ ${currentSlide + 1}`}
                  className="max-w-full max-h-full object-contain rounded-lg"
                />
              ) : (
                <div className="text-white/50 text-sm">画像がありません</div>
              )}
            </div>

            {/* Text Section */}
            <div className="w-full lg:w-96 p-6 overflow-y-auto bg-background border-t lg:border-t-0 lg:border-l">
              <div className="space-y-6">
                <div>
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-bold text-lg">
                      {currentSlide + 1}
                    </div>
                    <h3 className="text-xl font-bold">{currentStep.title}</h3>
                  </div>
                </div>

                <div>
                  <h4 className="text-sm font-medium text-muted-foreground mb-2">操作</h4>
                  <p className="text-foreground">{currentStep.operation}</p>
                </div>

                <div>
                  <h4 className="text-sm font-medium text-muted-foreground mb-2">説明</h4>
                  <p className="text-foreground">{currentStep.description}</p>
                </div>

                {currentStep.narration && (
                  <div className="p-4 bg-muted rounded-lg space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-medium text-muted-foreground">
                        ナレーション
                      </h4>
                      {currentStep.audioUrl && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={togglePlayPause}
                          className="h-8 px-3"
                        >
                          {isPlaying ? (
                            <>
                              <VolumeX className="h-4 w-4 mr-1" />
                              停止
                            </>
                          ) : (
                            <>
                              <Volume2 className="h-4 w-4 mr-1" />
                              再生
                            </>
                          )}
                        </Button>
                      )}
                    </div>
                    <p className="text-foreground italic">{currentStep.narration}</p>
                    {currentStep.audioUrl && (
                      <audio
                        ref={audioRef}
                        src={currentStep.audioUrl}
                        onEnded={handleAudioEnded}
                        onPlay={() => setIsPlaying(true)}
                        onPause={() => setIsPlaying(false)}
                        className="w-full h-8"
                        controls
                      />
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Footer Navigation */}
        <div className="flex items-center justify-between p-4 border-t bg-background">
          {/* Prev Button */}
          <Button
            variant="outline"
            onClick={goToPrev}
            disabled={currentSlide === 0}
            className="gap-2"
          >
            <ChevronLeft className="h-4 w-4" />
            前へ
          </Button>

          {/* Slide Indicator */}
          <div className="flex items-center gap-1.5">
            {steps.map((_, index) => (
              <button
                key={index}
                onClick={() => setCurrentSlide(index)}
                className={`w-2.5 h-2.5 rounded-full transition-colors ${
                  index === currentSlide
                    ? "bg-primary"
                    : "bg-muted-foreground/30 hover:bg-muted-foreground/50"
                }`}
                aria-label={`スライド ${index + 1} へ移動`}
              />
            ))}
          </div>

          {/* Next Button */}
          <Button
            variant="outline"
            onClick={goToNext}
            disabled={currentSlide === steps.length - 1}
            className="gap-2"
          >
            次へ
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        {/* Keyboard Shortcuts Hint */}
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 text-xs text-muted-foreground bg-background/80 px-3 py-1.5 rounded-full border shadow-sm">
          ← → キーで移動 | Space で次へ | Esc で閉じる
        </div>
      </DialogContent>
    </Dialog>
  );
}
