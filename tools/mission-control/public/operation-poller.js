/**
 * Authenticated same-origin polling fallback for streaming operation
 * status/logs.
 *
 * EventSource cannot attach custom request headers, so it cannot carry
 * the X-Mission-Control-Token required for remote access once
 * MISSION_CONTROL_AUTH_TOKEN is configured — in remote mode the
 * EventSource connection to /api/operations/:id/stream always fails with
 * a generic transport error. That failure says nothing about whether the
 * operation itself (a deploy/destroy/validate script running server-side)
 * succeeded, failed, or is still running. This module lets app.js fall
 * back to polling the plain JSON `GET /api/operations/:id` endpoint
 * through the shared, authenticated api() helper (see api-client.js),
 * which DOES attach the auth header — instead of ever putting the token
 * in a URL, which EventSource would otherwise tempt.
 *
 * Design invariants:
 *  - Only a server-reported terminal status (anything other than
 *    "running") calls onTerminal. A poll-level failure (network hiccup,
 *    a transient non-2xx response) never marks the operation failed; it
 *    is reported via onError and polling simply continues.
 *  - Polling is bounded and serialized: an in-flight guard plus
 *    recursive setTimeout scheduling (the same technique as
 *    poll-scheduler.js) means at most one poll is ever outstanding, and
 *    the next poll is only scheduled after the previous one settles.
 *  - Log entries are never duplicated: each poll requests only entries
 *    at or after the last known `since` cursor, advanced strictly by the
 *    server-reported `logLength` on each successful response.
 *  - After too many consecutive poll-level failures, polling gives up
 *    (onGiveUp) rather than continuing forever — but this is reported as
 *    "status unknown", never as a fabricated success or failure.
 *  - stop() is fenced against in-flight requests: a `generation` counter
 *    is bumped every time stop() is called, and captured at the start of
 *    each tick. The single `await api(...)` call is the only suspension
 *    point, so every continuation after it (and every subsequent
 *    callback/scheduling decision reachable from that continuation)
 *    re-checks `stopped`/`settled`/the captured generation before doing
 *    anything observable. A poller that has been stopped (or superseded
 *    by a newer poller instance for a different operation id) can never
 *    append a log line, flip the UI to a terminal state, or schedule
 *    another tick — no matter how late its in-flight request resolves.
 */
(function (root) {
  const DEFAULT_INTERVAL_MS = 1500;
  const DEFAULT_MAX_CONSECUTIVE_ERRORS = 20;

  /**
   * @param {object} options
   * @param {(path: string) => Promise<any>} options.api - the shared, authenticated api() helper.
   * @param {string} options.operationId
   * @param {number} [options.since] - initial log cursor to resume from (e.g. the number of log entries already rendered by a prior EventSource connection), so the very first poll never re-fetches/re-renders lines the caller already has. Defaults to 0.
   * @param {number} [options.intervalMs]
   * @param {number} [options.maxConsecutiveErrors]
   * @param {(entries: Array<object>) => void} [options.onLogEntries] - called with any NEW log entries since the last poll.
   * @param {(info: {status: string, exitCode: number|null}) => void} [options.onTerminal] - called exactly once, when the server reports a non-"running" status.
   * @param {(err: Error) => void} [options.onError] - called on a poll-level failure; polling continues unless the consecutive-failure cap is hit.
   * @param {() => void} [options.onGiveUp] - called at most once if the consecutive-error cap is exceeded; polling stops without ever calling onTerminal.
   */
  function createOperationPoller(options = {}) {
    const api = options.api;
    if (typeof api !== 'function') throw new Error('createOperationPoller requires an api(path) function');
    const operationId = options.operationId;
    if (!operationId) throw new Error('createOperationPoller requires an operationId');

    const intervalMs = options.intervalMs || DEFAULT_INTERVAL_MS;
    const maxConsecutiveErrors = options.maxConsecutiveErrors || DEFAULT_MAX_CONSECUTIVE_ERRORS;
    const onLogEntries = typeof options.onLogEntries === 'function' ? options.onLogEntries : () => {};
    const onTerminal = typeof options.onTerminal === 'function' ? options.onTerminal : () => {};
    const onError = typeof options.onError === 'function' ? options.onError : () => {};
    const onGiveUp = typeof options.onGiveUp === 'function' ? options.onGiveUp : () => {};
    const setTimeoutFn = options.setTimeout || setTimeout;
    const clearTimeoutFn = options.clearTimeout || clearTimeout;

    let sinceIndex = Number.isFinite(options.since) ? Math.max(0, Math.trunc(options.since)) : 0;
    let stopped = false;
    let settled = false; // true once onTerminal or onGiveUp has fired
    let inFlight = false;
    let consecutiveErrors = 0;
    let timer = null;
    let tickCount = 0;
    let generation = 0; // bumped by stop() so an in-flight request can detect it was superseded

    function stillCurrent(tickGeneration) {
      return !stopped && !settled && generation === tickGeneration;
    }

    function scheduleNext(tickGeneration) {
      if (!stillCurrent(tickGeneration)) return;
      timer = setTimeoutFn(tick, intervalMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }

    async function tick() {
      if (stopped || settled) return;
      if (inFlight) return; // recursive scheduling already prevents overlap; this is a defensive no-op
      inFlight = true;
      tickCount += 1;
      const tickGeneration = generation;

      let data = null;
      let caughtError = null;
      try {
        data = await api(`operations/${encodeURIComponent(operationId)}?since=${sinceIndex}`);
      } catch (err) {
        caughtError = err;
      }

      // Fence: stop() may have been called (directly, or implicitly by
      // app.js starting a new poller for a different operation id) while
      // this request was in flight. If so, this poller instance is dead —
      // never touch sinceIndex/consecutiveErrors, never call any
      // callback, never schedule another tick.
      if (!stillCurrent(tickGeneration)) { inFlight = false; return; }

      if (caughtError || !data || data.error) {
        consecutiveErrors += 1;
        const err = caughtError
          ? (caughtError instanceof Error ? caughtError : new Error(String(caughtError)))
          : new Error((data && data.error) || 'Empty response while polling operation status');
        if (stillCurrent(tickGeneration)) onError(err);
        if (!stillCurrent(tickGeneration)) { inFlight = false; return; }
        if (consecutiveErrors >= maxConsecutiveErrors) {
          settled = true;
          inFlight = false;
          onGiveUp();
          return; // give up — never fabricate a terminal status
        }
        inFlight = false;
        scheduleNext(tickGeneration);
        return;
      }

      consecutiveErrors = 0;
      if (Array.isArray(data.log) && data.log.length > 0) {
        if (stillCurrent(tickGeneration)) onLogEntries(data.log);
        if (!stillCurrent(tickGeneration)) { inFlight = false; return; }
      }
      sinceIndex = typeof data.logLength === 'number' ? data.logLength : sinceIndex;
      if (data.status && data.status !== 'running') {
        settled = true;
        inFlight = false;
        onTerminal({ status: data.status, exitCode: data.exitCode != null ? data.exitCode : null });
        return; // terminal — do not scheduleNext
      }
      inFlight = false;
      scheduleNext(tickGeneration);
    }

    return {
      start() { scheduleNext(generation); },
      stop() {
        stopped = true;
        generation += 1;
        if (timer) clearTimeoutFn(timer);
      },
      isInFlight: () => inFlight,
      get sinceIndex() { return sinceIndex; },
      get tickCount() { return tickCount; },
    };
  }

  const moduleExport = { createOperationPoller, DEFAULT_INTERVAL_MS, DEFAULT_MAX_CONSECUTIVE_ERRORS };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = moduleExport;
  }
  root.MissionControlOperationPoller = moduleExport;
})(typeof window !== 'undefined' ? window : globalThis);
