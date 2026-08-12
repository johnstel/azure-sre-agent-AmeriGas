/**
 * Pure decision logic for interpreting a DELETE /api/operations/:id
 * response. Extracted from app.js's cancelOperation() so the
 * cancel-won vs already-finished branching can be unit tested without a
 * real browser DOM/fetch.
 *
 * The server's response is authoritative and truthful: cancellation can
 * legitimately have "no effect" because the operation already reached a
 * different terminal state (completed/failed/cancelled by something
 * else, or was never running) before this request won the race — see
 * operation-lifecycle.js's cancelOperation(). This module branches on
 * the response's explicit `cancelled` boolean (never on parsing the
 * human-readable `message` string, which is brittle and easy to misread
 * as success), so a caller can never show a fabricated "Operation
 * cancelled" success toast for a cancellation that didn't actually
 * happen.
 */
(function (root) {
  /**
   * @param {object} input
   * @param {boolean} input.ok - whether the HTTP response was 2xx.
   * @param {number} [input.status] - the HTTP status code, used only for a generic error message when the body has no `error` field.
   * @param {{cancelled?: boolean, status?: string, exitCode?: number|null, error?: string}|null} input.data - the parsed JSON response body, or null if it couldn't be parsed.
   * @returns {{toastMessage: string, toastType: 'success'|'error'|'info', terminalInfo: {status: string, exitCode: number|null}|null}}
   *   `terminalInfo` is non-null only when the response reports a genuine terminal status (not 'running') for an operation that was NOT
   *   cancelled by this request — the caller should use it to proactively sync the UI to the server's truthful state.
   */
  function interpretCancelOperationResponse({ ok, status: httpStatus, data } = {}) {
    if (!ok) {
      return {
        toastMessage: (data && data.error) || ('Cancel failed (HTTP ' + httpStatus + ')'),
        toastType: 'error',
        terminalInfo: null,
      };
    }

    if (data && data.cancelled === true) {
      return { toastMessage: 'Operation cancelled', toastType: 'success', terminalInfo: null };
    }

    // Cancellation lost the race (or there was nothing running to
    // cancel). Never claim success — report the real status truthfully.
    const opStatus = data && data.status;
    const toastMessage = opStatus
      ? ('Cancel had no effect — operation already ' + opStatus)
      : 'Cancel had no effect — operation already finished';
    const terminalInfo = (opStatus && opStatus !== 'running')
      ? { status: opStatus, exitCode: (data.exitCode != null ? data.exitCode : null) }
      : null;

    return { toastMessage, toastType: 'info', terminalInfo };
  }

  const moduleExport = { interpretCancelOperationResponse };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = moduleExport;
  }
  root.MissionControlCancelResponse = moduleExport;
})(typeof window !== 'undefined' ? window : globalThis);
