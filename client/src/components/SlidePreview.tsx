import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { ChevronLeft, ChevronRight, X, Maximize2, Minimize2, Volume2, VolumeX, PanelRightClose, PanelRightOpen } from "lucide-react";
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
  const [showPanel, setShowPanel] = useState(true);
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
      } else if (e.key === "p" || e.key === "P") {
        setShowPanel((prev) => !prev);
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
      <DialogContent className="max-w-[98vw] w-full max-h-[95vh] h-[90vh] p-0 gap-0 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 border-b bg-background shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary text-primary-foreground text-sm font-bold">
              {currentSlide + 1}
            </div>
            <div>
              <h2 className="font-semibold text-sm truncate max-w-[200px] sm:max-w-none">{currentStep.title}</h2>
              <span className="text-xs text-muted-foreground">
                {currentSlide + 1} / {steps.length}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant={autoPlay ? "default" : "ghost"}
              size="sm"
              onClick={() => setAutoPlay(!autoPlay)}
              title={autoPlay ? "自動再生オフ" : "自動再生オン"}
              className="h-8 px-2"
            >
              <Volume2 className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowPanel(!showPanel)}
              title={showPanel ? "パネルを隠す (P)" : "パネルを表示 (P)"}
              className="h-8 px-2"
            >
              {showPanel ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleFullscreen}
              title={isFullscreen ? "フルスクリーン解除" : "フルスクリーン"}
              className="h-8 px-2"
            >
              {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose} className="h-8 px-2">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Main Content */}
        <div className="flex-1 flex overflow-hidden min-h-0">
          {/* Image Section - Takes most of the space */}
          <div className="flex-1 flex items-center justify-center bg-neutral-900 p-2 relative">
            {currentFrame ? (
              <img
                src={currentFrame.imageUrl}
                alt={`ステップ ${currentSlide + 1}`}
                className="max-w-full max-h-full object-contain"
                style={{ maxHeight: 'calc(100% - 16px)' }}
              />
            ) : (
              <div className="text-white/50 text-sm">画像がありません</div>
            )}

            {/* Navigation Overlay */}
            <button
              onClick={goToPrev}
              disabled={currentSlide === 0}
              className="absolute left-2 top-1/2 -translate-y-1/2 w-12 h-12 flex items-center justify-center rounded-full bg-black/30 hover:bg-black/50 text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft className="h-6 w-6" />
            </button>
            <button
              onClick={goToNext}
              disabled={currentSlide === steps.length - 1}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-12 h-12 flex items-center justify-center rounded-full bg-black/30 hover:bg-black/50 text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight className="h-6 w-6" />
            </button>
          </div>

          {/* Info Panel - Collapsible */}
          {showPanel && (
            <div className="w-80 shrink-0 overflow-y-auto bg-background border-l">
              <div className="p-4 space-y-4">
                <div>
                  <h3 className="font-bold text-lg">{currentStep.title}</h3>
                </div>

                <div>
                  <h4 className="text-xs font-medium text-muted-foreground mb-1">操作</h4>
                  <p className="text-sm">{currentStep.operation}</p>
                </div>

                <div>
                  <h4 className="text-xs font-medium text-muted-foreground mb-1">説明</h4>
                  <p className="text-sm">{currentStep.description}</p>
                </div>

                {currentStep.narration && (
                  <div className="p-3 bg-muted rounded-lg space-y-2">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-medium text-muted-foreground">ナレーション</h4>
                      {currentStep.audioUrl && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={togglePlayPause}
                          className="h-7 px-2 text-xs"
                        >
                          {isPlaying ? (
                            <>
                              <VolumeX className="h-3 w-3 mr-1" />
                              停止
                            </>
                          ) : (
                            <>
                              <Volume2 className="h-3 w-3 mr-1" />
                              再生
                            </>
                          )}
                        </Button>
                      )}
                    </div>
                    <p className="text-sm italic text-muted-foreground">{currentStep.narration}</p>
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
          )}
        </div>

        {/* Footer - Slide Indicator */}
        <div className="flex items-center justify-center gap-2 p-2 border-t bg-background shrink-0">
          <div className="flex items-center gap-1 overflow-x-auto max-w-full px-2">
            {steps.length <= 20 ? (
              // Show dots for <= 20 slides
              steps.map((_, index) => (
                <button
                  key={index}
                  onClick={() => setCurrentSlide(index)}
                  className={`w-2 h-2 rounded-full transition-colors shrink-0 ${
                    index === currentSlide
                      ? "bg-primary"
                      : "bg-muted-foreground/30 hover:bg-muted-foreground/50"
                  }`}
                  aria-label={`スライド ${index + 1} へ移動`}
                />
              ))
            ) : (
              // Show mini slider for > 20 slides
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{currentSlide + 1}</span>
                <input
                  type="range"
                  min={0}
                  max={steps.length - 1}
                  value={currentSlide}
                  onChange={(e) => setCurrentSlide(parseInt(e.target.value))}
                  className="w-32"
                />
                <span className="text-xs text-muted-foreground">{steps.length}</span>
              </div>
            )}
          </div>
        </div>

        {/* Keyboard Shortcuts Hint */}
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2 text-[10px] text-muted-foreground bg-background/90 px-2 py-1 rounded border shadow-sm whitespace-nowrap">
          ← → 移動 | Space 次へ | P パネル | Esc 閉じる
        </div>
      </DialogContent>
    </Dialog>
  );
}
