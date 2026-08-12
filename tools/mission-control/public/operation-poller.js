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
 */
(function (root) {
  const DEFAULT_INTERVAL_MS = 1500;
  const DEFAULT_MAX_CONSECUTIVE_ERRORS = 20;

  /**
   * @param {object} options
   * @param {(path: string) => Promise<any>} options.api - the shared, authenticated api() helper.
   * @param {string} options.operationId
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

    let sinceIndex = 0;
    let stopped = false;
    let settled = false; // true once onTerminal or onGiveUp has fired
    let inFlight = false;
    let consecutiveErrors = 0;
    let timer = null;
    let tickCount = 0;

    function scheduleNext() {
      if (stopped || settled) return;
      timer = setTimeoutFn(tick, intervalMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }

    async function tick() {
      if (stopped || settled) return;
      if (inFlight) { scheduleNext(); return; } // defensive; recursive scheduling already prevents overlap
      inFlight = true;
      tickCount += 1;
      try {
        const data = await api(`operations/${encodeURIComponent(operationId)}?since=${sinceIndex}`);
        if (!data || data.error) {
          throw new Error((data && data.error) || 'Empty response while polling operation status');
        }
        consecutiveErrors = 0;
        if (Array.isArray(data.log) && data.log.length > 0) {
          onLogEntries(data.log);
        }
        sinceIndex = typeof data.logLength === 'number' ? data.logLength : sinceIndex;
        if (data.status && data.status !== 'running') {
          settled = true;
          onTerminal({ status: data.status, exitCode: data.exitCode != null ? data.exitCode : null });
          inFlight = false;
          return; // terminal — do not scheduleNext
        }
      } catch (err) {
        consecutiveErrors += 1;
        onError(err instanceof Error ? err : new Error(String(err)));
        if (consecutiveErrors >= maxConsecutiveErrors) {
          settled = true;
          inFlight = false;
          onGiveUp();
          return; // give up — never fabricate a terminal status
        }
      }
      inFlight = false;
      scheduleNext();
    }

    return {
      start() { scheduleNext(); },
      stop() {
        stopped = true;
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
