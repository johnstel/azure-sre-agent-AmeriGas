/**
 * Shared API client for Mission Control's browser UI.
 *
 * Centralizes three security-sensitive concerns so every network call in
 * app.js gets consistent behavior instead of each call site reimplementing
 * its own fetch options:
 *
 * 1. CSRF tokens are single-use server-side (see security.js
 *    createCsrfTokenStore — validate() deletes the token on use). Every
 *    state-changing request therefore fetches a brand-new token rather
 *    than reusing a cached one, so concurrent mutations never race for
 *    the same token. A narrow safety net retries a request exactly once,
 *    and only when the server explicitly rejects it as an invalid CSRF
 *    token (never a blind retry for any other failure).
 *
 * 2. The optional remote-access token (X-Mission-Control-Token, required
 *    by server.js for any /api/* call from a non-loopback address once
 *    MISSION_CONTROL_AUTH_TOKEN is configured) is kept in memory and, if a
 *    Storage-like object is supplied, in sessionStorage — never
 *    localStorage, never a query string, never logged. It is attached as
 *    a request header on every /api/* call (harmless to include when
 *    running locally, since the server only checks it for non-loopback
 *    requests). If a request is rejected with 401, an injectable
 *    `onAuthRequired` callback is invoked to collect the token from the
 *    operator (e.g. via a modal), and the request is retried exactly once
 *    with the supplied token. Concurrent 401s share a single prompt
 *    instead of opening multiple prompts.
 *
 * 3. All of the above is exposed through one `api()`/`request()` pair so
 *    call sites don't need to reimplement header building.
 */
(function (root) {
  const REMOTE_TOKEN_HEADER = 'X-Mission-Control-Token';
  const REMOTE_TOKEN_STORAGE_KEY = 'missionControlRemoteToken';
  const CSRF_TOKEN_PATH = 'csrf-token';

  function safeStorageGet(storage, key) {
    if (!storage) return null;
    try {
      return storage.getItem(key);
    } catch {
      return null; // storage disabled (private browsing, quota, etc.) — fall back to in-memory only
    }
  }

  function safeStorageSet(storage, key, value) {
    if (!storage) return;
    try {
      if (value) storage.setItem(key, value);
      else storage.removeItem(key);
    } catch {
      /* ignore — in-memory value is still authoritative for this page's lifetime */
    }
  }

  /**
   * @param {object} [options]
   * @param {typeof fetch} [options.fetch] - injectable for tests; defaults to the global fetch.
   * @param {Storage|null} [options.storage] - injectable Storage-like object (getItem/setItem/removeItem);
   *   defaults to window.sessionStorage when available. Pass `null` explicitly for in-memory-only behavior.
   * @param {() => Promise<string|null>} [options.onAuthRequired] - called when a request is rejected with 401;
   *   should resolve with the token the operator supplied, or null if they cancelled.
   */
  function createApiClient(options = {}) {
    const fetchImpl = options.fetch || (typeof fetch !== 'undefined' ? fetch : undefined);
    const storage = options.storage !== undefined
      ? options.storage
      : (typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null);
    const onAuthRequired = typeof options.onAuthRequired === 'function' ? options.onAuthRequired : null;

    let cachedCsrfToken = null;
    let remoteToken = safeStorageGet(storage, REMOTE_TOKEN_STORAGE_KEY) || null;
    let pendingAuthPrompt = null; // de-dupes concurrent 401s into a single prompt

    function getRemoteToken() {
      return remoteToken;
    }

    function setRemoteToken(token) {
      remoteToken = token || null;
      safeStorageSet(storage, REMOTE_TOKEN_STORAGE_KEY, remoteToken);
    }

    function clearRemoteToken() {
      setRemoteToken(null);
    }

    /** Always issues a brand-new request for a token — never reused/shared across concurrent callers. */
    async function fetchFreshCsrfToken() {
      const response = await requestRaw(CSRF_TOKEN_PATH, {}, 0);
      if (!response || !response.ok) return null;
      const data = await response.json().catch(() => null);
      return (data && data.token) || null;
    }

    /**
     * Returns the CSRF token to use. By default (forceRefresh=false) this
     * may return a previously fetched value; callers making a
     * state-changing request must pass forceRefresh=true so every mutation
     * gets its own single-use token instead of racing another in-flight
     * mutation for the same one.
     */
    async function getCsrfToken(forceRefresh = false) {
      if (!forceRefresh && cachedCsrfToken) return cachedCsrfToken;
      const token = await fetchFreshCsrfToken();
      cachedCsrfToken = token;
      return token;
    }

    function invalidateCsrfToken() {
      cachedCsrfToken = null;
    }

    async function buildRequestOptions(opts = {}, internal = {}) {
      const headers = new Headers(opts.headers || {});
      const method = String(opts.method || 'GET').toUpperCase();
      const isMutating = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
      if (isMutating && !internal.skipCsrf) {
        const token = await getCsrfToken(true);
        if (token) headers.set('X-CSRF-Token', token);
      }
      if (opts.body !== undefined && !headers.has('Content-Type') && !(opts.body instanceof FormData)) {
        headers.set('Content-Type', 'application/json');
      }
      if (remoteToken) {
        headers.set(REMOTE_TOKEN_HEADER, remoteToken);
      }
      return { ...opts, headers };
    }

    async function isExplicitCsrfRejection(response) {
      if (!response || response.status !== 403 || typeof response.clone !== 'function') return false;
      try {
        const body = await response.clone().json();
        return Boolean(body && typeof body.error === 'string' && /invalid csrf token/i.test(body.error));
      } catch {
        return false;
      }
    }

    async function requestAuthToken() {
      if (!pendingAuthPrompt) {
        pendingAuthPrompt = Promise.resolve()
          .then(() => onAuthRequired())
          .finally(() => { pendingAuthPrompt = null; });
      }
      return pendingAuthPrompt;
    }

    async function requestRaw(path, opts, attempt, internal = {}) {
      const requestOptions = await buildRequestOptions(opts, internal);
      const url = '/api/' + String(path).replace(/^\/+/, '');
      const response = await fetchImpl(url, requestOptions);

      // Narrow, explicit-rejection-only retry: never replay a mutation
      // just because it failed for some other reason.
      if (attempt === 0 && await isExplicitCsrfRejection(response)) {
        invalidateCsrfToken();
        return requestRaw(path, opts, attempt + 1, internal);
      }

      if (attempt === 0 && response && response.status === 401 && onAuthRequired) {
        const suppliedToken = await requestAuthToken();
        if (suppliedToken) {
          setRemoteToken(suppliedToken);
          return requestRaw(path, opts, attempt + 1, internal);
        }
      }

      return response;
    }

    async function request(path, opts = {}) {
      return requestRaw(path, opts, 0);
    }

    async function api(path, opts = {}) {
      const response = await request(path, opts);
      return response.json();
    }

    return {
      api,
      request,
      buildRequestOptions: (opts) => buildRequestOptions(opts, {}),
      getCsrfToken: () => getCsrfToken(false),
      invalidateCsrfToken,
      getRemoteToken,
      setRemoteToken,
      clearRemoteToken,
    };
  }

  const moduleExport = { createApiClient, REMOTE_TOKEN_HEADER, REMOTE_TOKEN_STORAGE_KEY };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = moduleExport;
  }
  root.MissionControlApiClient = moduleExport;
})(typeof window !== 'undefined' ? window : globalThis);
