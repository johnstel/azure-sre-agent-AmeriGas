/**
 * A tiny recursive-setTimeout based polling scheduler with an in-flight
 * guard.
 *
 * `setInterval(asyncFn, ms)` fires on a fixed wall-clock cadence regardless
 * of whether the previous invocation of an async callback has finished. If
 * a tick is slow (e.g. a kubectl call that hangs or is simply slower than
 * the poll interval), the next tick can start while the previous one is
 * still running, and both ticks can race each other while mutating the
 * same incident state. This scheduler instead always waits for one
 * invocation to fully settle (success or failure) before scheduling the
 * next one, so at most one tick is ever in flight.
 */
function createPoller(fn, intervalMs, options = {}) {
  const setTimeoutFn = options.setTimeout || setTimeout;
  const clearTimeoutFn = options.clearTimeout || clearTimeout;
  let timer = null;
  let stopped = false;
  let inFlight = false;
  let tickCount = 0;

  function scheduleNext() {
    if (stopped) return;
    timer = setTimeoutFn(runTick, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function runTick() {
    if (stopped) return;
    if (inFlight) {
      // Defensive only: recursive scheduling below means a new tick is
      // never scheduled until the previous one finishes, so this branch
      // should be unreachable in practice. Kept as a guard against future
      // changes (or re-entrant calls from tests) that might invoke runTick
      // directly.
      scheduleNext();
      return;
    }
    inFlight = true;
    tickCount += 1;
    try {
      await fn();
    } catch (err) {
      // The scheduler must never let a rejecting tick escape as an
      // unhandled promise rejection or stop future polling — a single bad
      // tick (e.g. a transient cluster call failure) should not take down
      // the poll loop. Callers can still observe failures via onError.
      if (typeof options.onError === 'function') {
        try { options.onError(err); } catch { /* ignore errors from the error handler itself */ }
      }
    } finally {
      inFlight = false;
      scheduleNext();
    }
  }

  scheduleNext();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeoutFn(timer);
    },
    isInFlight: () => inFlight,
    get tickCount() {
      return tickCount;
    },
  };
}

module.exports = { createPoller };
