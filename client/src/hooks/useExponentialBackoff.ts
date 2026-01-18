import { useCallback, useEffect, useRef, useState } from "react";

export type ExponentialBackoffOptions = {
  /** Initial polling interval in milliseconds (default: 1000) */
  initialInterval?: number;
  /** Maximum polling interval in milliseconds (default: 30000) */
  maxInterval?: number;
  /** Backoff multiplier (default: 1.5) */
  multiplier?: number;
  /** Reset interval on success (default: true) */
  resetOnSuccess?: boolean;
};

type PollingState = {
  /** Current polling interval */
  interval: number;
  /** Number of consecutive errors */
  errorCount: number;
  /** Whether polling is active */
  isActive: boolean;
};

const DEFAULT_OPTIONS: Required<ExponentialBackoffOptions> = {
  initialInterval: 1000,
  maxInterval: 30000,
  multiplier: 1.5,
  resetOnSuccess: true,
};

/**
 * Custom hook for exponential backoff polling
 *
 * @param callback - Async function to call on each poll
 * @param shouldPoll - Whether polling should be active
 * @param options - Configuration options
 * @returns Object with polling state and control functions
 */
export function useExponentialBackoff<T>(
  callback: () => Promise<T>,
  shouldPoll: boolean,
  options: ExponentialBackoffOptions = {}
) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const [state, setState] = useState<PollingState>({
    interval: opts.initialInterval,
    errorCount: 0,
    isActive: false,
  });

  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  // Reset interval to initial value
  const resetInterval = useCallback(() => {
    setState(prev => ({
      ...prev,
      interval: opts.initialInterval,
      errorCount: 0,
    }));
  }, [opts.initialInterval]);

  // Increase interval with exponential backoff
  const increaseInterval = useCallback(() => {
    setState(prev => {
      const newInterval = Math.min(
        prev.interval * opts.multiplier,
        opts.maxInterval
      );
      return {
        ...prev,
        interval: newInterval,
        errorCount: prev.errorCount + 1,
      };
    });
  }, [opts.multiplier, opts.maxInterval]);

  // Execute polling
  useEffect(() => {
    if (!shouldPoll) {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      setState(prev => ({ ...prev, isActive: false }));
      return;
    }

    setState(prev => ({ ...prev, isActive: true }));

    const poll = async () => {
      try {
        await callbackRef.current();
        if (opts.resetOnSuccess) {
          resetInterval();
        }
      } catch (error) {
        console.error("Polling error:", error);
        increaseInterval();
      }

      // Schedule next poll
      if (shouldPoll) {
        timeoutRef.current = setTimeout(poll, state.interval);
      }
    };

    // Start polling
    timeoutRef.current = setTimeout(poll, state.interval);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [shouldPoll, state.interval, opts.resetOnSuccess, resetInterval, increaseInterval]);

  // Reset when polling stops
  useEffect(() => {
    if (!shouldPoll) {
      resetInterval();
    }
  }, [shouldPoll, resetInterval]);

  return {
    /** Current polling interval in milliseconds */
    currentInterval: state.interval,
    /** Number of consecutive errors */
    errorCount: state.errorCount,
    /** Whether polling is currently active */
    isActive: state.isActive,
    /** Manually reset interval to initial value */
    resetInterval,
  };
}

/**
 * Simplified hook for progress polling with exponential backoff
 * Automatically handles multiple project IDs
 */
export function useProgressPolling<T>(
  fetchProgress: (id: number) => Promise<T>,
  projectIds: Set<number>,
  onProgress: (id: number, data: T) => void,
  onComplete: (id: number) => void,
  isComplete: (data: T) => boolean,
  options: ExponentialBackoffOptions = {}
) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const [intervalMs, setIntervalMs] = useState(opts.initialInterval);
  const [errorCounts, setErrorCounts] = useState<Map<number, number>>(new Map());

  useEffect(() => {
    if (projectIds.size === 0) {
      setIntervalMs(opts.initialInterval);
      return;
    }

    const poll = async () => {
      const ids = Array.from(projectIds);
      let hasError = false;

      for (const id of ids) {
        try {
          const data = await fetchProgress(id);
          onProgress(id, data);

          // Reset error count for this project on success
          setErrorCounts(prev => {
            const next = new Map(prev);
            next.delete(id);
            return next;
          });

          if (isComplete(data)) {
            onComplete(id);
          }
        } catch (error) {
          console.error(`Failed to fetch progress for project ${id}:`, error);
          hasError = true;

          // Increment error count for this project
          setErrorCounts(prev => {
            const next = new Map(prev);
            next.set(id, (prev.get(id) || 0) + 1);
            return next;
          });
        }
      }

      // Adjust interval based on overall success/failure
      if (hasError) {
        setIntervalMs(prev =>
          Math.min(prev * opts.multiplier, opts.maxInterval)
        );
      } else if (opts.resetOnSuccess) {
        setIntervalMs(opts.initialInterval);
      }
    };

    const timeout = setTimeout(poll, intervalMs);
    return () => clearTimeout(timeout);
  }, [projectIds, intervalMs, fetchProgress, onProgress, onComplete, isComplete, opts]);

  return {
    currentInterval: intervalMs,
    errorCounts,
  };
}
