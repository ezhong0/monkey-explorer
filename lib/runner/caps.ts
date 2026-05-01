// Wall-clock timer that forcibly closes the BB session when fired.
// Stagehand v3 doesn't accept AbortSignal, so we cancel by closing the
// underlying CDP connection — agent.execute throws when its connection
// drops, which runMission catches and classifies as `timed_out`.

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
  const timer = setTimeout(() => {
    didFire = true;
    opts.onFire().catch(() => {});
  }, opts.wallClockMs);

  // Also clear if the abort signal fires.
  const abortHandler = () => {
    clearTimeout(timer);
  };
  opts.signal.addEventListener('abort', abortHandler, { once: true });

  return {
    clear: () => {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', abortHandler);
    },
    fired: () => didFire,
  };
}
