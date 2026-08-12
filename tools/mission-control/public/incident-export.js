/**
 * Downloads a redacted incident evidence-pack export.
 *
 * A plain `window.open()`/top-level navigation to the export URL cannot
 * attach the X-Mission-Control-Token header required for remote access
 * (browsers don't allow custom headers on navigation), so it always
 * fails once remote access is enabled. Instead, this fetches the export
 * through the caller's already-authenticated `request()` function (e.g.
 * apiClient.request, which attaches the auth header, handles the
 * 401-prompt flow, etc. — exactly like every other API call), reads the
 * response body as a Blob, and triggers the download via a short-lived
 * object URL. The token is never placed in a URL, the DOM, a log, or the
 * exported content itself — the server has already redacted the content
 * before this module ever sees it.
 *
 * Extracted into its own module (dependency-injected: request/document/
 * URL/setTimeout are all injectable) so the download flow — including
 * error handling and object URL cleanup — can be unit tested without a
 * real browser DOM.
 */
(function (root) {
  /**
   * @param {object} deps
   * @param {(path: string) => Promise<Response>} deps.request - the shared, authenticated request() function (e.g. apiClient.request). Must resolve to a fetch-like Response (`.ok`, `.status`, `.blob()`, `.headers.get()`, `.clone()`).
   * @param {string} deps.correlationId
   * @param {'md'|'json'} deps.format
   * @param {Document} [deps.documentImpl] - injectable for tests; defaults to the global `document`.
   * @param {{createObjectURL: (blob: any) => string, revokeObjectURL: (url: string) => void}} [deps.urlImpl] - injectable for tests; defaults to the global `URL`.
   * @param {(message: string) => void} [deps.onError] - called with a human-readable message on any failure. Never throws.
   * @param {number} [deps.revokeDelayMs] - delay before revoking the object URL; defaults to 1000ms.
   * @param {typeof setTimeout} [deps.setTimeoutFn] - injectable for tests; defaults to the global setTimeout.
   * @returns {Promise<{ok: true, filename: string, objectUrl: string} | {ok: false, reason: string}>}
   */
  async function downloadIncidentExport(deps = {}) {
    const {
      request,
      correlationId,
      format,
      documentImpl = (typeof document !== 'undefined' ? document : undefined),
      urlImpl = (typeof URL !== 'undefined' ? URL : undefined),
      onError = () => {},
      revokeDelayMs = 1000,
      setTimeoutFn = (typeof setTimeout !== 'undefined' ? setTimeout : (fn) => fn()),
    } = deps;

    if (typeof request !== 'function') throw new Error('downloadIncidentExport requires a request(path) function');
    if (!correlationId) return { ok: false, reason: 'no-correlation-id' };

    const path = 'incidents/' + encodeURIComponent(correlationId) + '/export.' + format;

    let response;
    try {
      response = await request(path);
    } catch (err) {
      onError('Export failed: ' + (err && err.message ? err.message : String(err)));
      return { ok: false, reason: 'network-error' };
    }

    if (!response || !response.ok) {
      let message = 'Export failed (HTTP ' + (response ? response.status : 'unknown') + ')';
      try {
        const body = await response.clone().json();
        if (body && body.error) message = body.error;
      } catch { /* response body wasn't JSON; keep the generic status message */ }
      onError(message);
      return { ok: false, reason: 'http-error' };
    }

    const blob = await response.blob();
    const disposition = (response.headers && typeof response.headers.get === 'function' ? response.headers.get('Content-Disposition') : null) || '';
    const filenameMatch = disposition.match(/filename="([^"]+)"/);
    const filename = filenameMatch ? filenameMatch[1] : (correlationId + '.' + format);

    const objectUrl = urlImpl.createObjectURL(blob);
    const anchor = documentImpl.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    documentImpl.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoke shortly after triggering the download rather than
    // immediately — click() synchronously starts the download in every
    // modern browser, but a short delay avoids any edge-case risk of
    // revoking before the download has actually begun.
    setTimeoutFn(() => urlImpl.revokeObjectURL(objectUrl), revokeDelayMs);

    return { ok: true, filename, objectUrl };
  }

  const moduleExport = { downloadIncidentExport };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = moduleExport;
  }
  root.MissionControlIncidentExport = moduleExport;
})(typeof window !== 'undefined' ? window : globalThis);
