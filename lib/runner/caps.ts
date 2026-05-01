// Wall-clock timer that forcibly closes the BB session when fired.
// Stagehand v3 doesn't accept AbortSignal, so we cancel by closing the
// underlying CDP connection — agent.execute throws when its connection
// drops, which runMission catches and classifies as `timed_out`.
//
// Race guard: the timer callback re-checks `cancelled` synchronously before
// invoking onFire. If clear() runs while the callback is already queued
// (clearTimeout doesn't always cancel an already-armed timer in time),
// `cancelled` will be observed and the callback no-ops rather than firing
// a spurious session close.

export interface WallClockTimer {
  /** Clear the timer. Idempotent. Call in finally. */
  clear: () => void;
  /** Returns true once the timer has fired. */
  fired: () => boolean;
}

export function startWallClockTimer(opts: {
  wallClockMs: number;
  onFire: () => Promise<void>;
  signal: AbortSignal;
}): WallClockTimer {
  let didFire = false;
  let cancelled = false;

  const timer = setTimeout(() => {
    if (cancelled) return;
    didFire = true;
    opts.onFire().catch(() => {});
  }, opts.wallClockMs);

  const abortHandler = () => {
    cancelled = true;
    clearTimeout(timer);
  };
  opts.signal.addEventListener('abort', abortHandler, { once: true });

  return {
    clear: () => {
      cancelled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', abortHandler);
    },
    fired: () => didFire,
  };
}
