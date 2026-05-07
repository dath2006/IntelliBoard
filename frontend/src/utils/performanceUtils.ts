/**
 * Performance utility functions for optimizing rendering and event handling
 */

/**
 * Throttle function execution to a maximum frequency
 * @param fn Function to throttle
 * @param delay Minimum time between executions in milliseconds
 * @returns Throttled function
 */
export function throttle<T extends (...args: any[]) => any>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let lastCall = 0;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return function throttled(...args: Parameters<T>) {
    const now = performance.now();
    const timeSinceLastCall = now - lastCall;

    if (timeSinceLastCall >= delay) {
      lastCall = now;
      fn(...args);
    } else {
      // Schedule for later if not already scheduled
      if (!timeoutId) {
        timeoutId = setTimeout(() => {
          lastCall = performance.now();
          timeoutId = null;
          fn(...args);
        }, delay - timeSinceLastCall);
      }
    }
  };
}

/**
 * Debounce function execution - only execute after a period of inactivity
 * @param fn Function to debounce
 * @param delay Delay in milliseconds
 * @returns Debounced function
 */
export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return function debounced(...args: Parameters<T>) {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      fn(...args);
    }, delay);
  };
}

/**
 * Request animation frame throttle - ensures function runs at most once per frame
 * @param fn Function to throttle
 * @returns RAF-throttled function
 */
export function rafThrottle<T extends (...args: any[]) => any>(
  fn: T
): (...args: Parameters<T>) => void {
  let rafId: number | null = null;
  let latestArgs: Parameters<T> | null = null;

  return function throttled(...args: Parameters<T>) {
    latestArgs = args;

    if (rafId === null) {
      rafId = requestAnimationFrame(() => {
        if (latestArgs) {
          fn(...latestArgs);
        }
        rafId = null;
        latestArgs = null;
      });
    }
  };
}

/**
 * Batch multiple state updates into a single update
 * Useful for reducing React re-renders
 */
export class UpdateBatcher<K, V> {
  private updates = new Map<K, V>();
  private rafId: number | null = null;
  private flushCallback: (updates: Map<K, V>) => void;

  constructor(flushCallback: (updates: Map<K, V>) => void) {
    this.flushCallback = flushCallback;
  }

  add(key: K, value: V): void {
    this.updates.set(key, value);

    if (this.rafId === null) {
      this.rafId = requestAnimationFrame(() => {
        this.flush();
      });
    }
  }

  flush(): void {
    if (this.updates.size > 0) {
      this.flushCallback(new Map(this.updates));
      this.updates.clear();
    }
    this.rafId = null;
  }

  cancel(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.updates.clear();
  }
}

/**
 * Measure and log performance of a function
 * @param label Label for the measurement
 * @param fn Function to measure
 * @param warnThreshold Threshold in ms to trigger warning
 */
export function measurePerformance<T>(
  label: string,
  fn: () => T,
  warnThreshold = 16
): T {
  const start = performance.now();
  const result = fn();
  const duration = performance.now() - start;

  if (duration > warnThreshold) {
    console.warn(`[Performance] ${label} took ${duration.toFixed(2)}ms (threshold: ${warnThreshold}ms)`);
  }

  return result;
}

/**
 * Create a memoized version of a function with custom equality check
 */
export function memoize<T extends (...args: any[]) => any>(
  fn: T,
  keyFn?: (...args: Parameters<T>) => string
): T {
  const cache = new Map<string, ReturnType<T>>();

  return ((...args: Parameters<T>) => {
    const key = keyFn ? keyFn(...args) : JSON.stringify(args);
    
    if (cache.has(key)) {
      return cache.get(key)!;
    }

    const result = fn(...args);
    cache.set(key, result);
    
    // Limit cache size to prevent memory leaks
    if (cache.size > 100) {
      const firstKey = cache.keys().next().value;
      cache.delete(firstKey);
    }

    return result;
  }) as T;
}
