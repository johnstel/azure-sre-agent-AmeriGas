# Mission Control hardening

Mission Control now binds to loopback by default and requires a CSRF token for state-changing requests. Loopback detection uses the peer socket address only; forwarded headers such as X-Forwarded-For and X-Real-IP are ignored.

## Defaults

- `MISSION_CONTROL_HOST` defaults to `127.0.0.1` unless `MISSION_CONTROL_ALLOW_REMOTE=true` is set.
- Remote access to `/api/*` is disabled unless `MISSION_CONTROL_AUTH_TOKEN` is configured.
- Privileged tool calls remain blocked unless they are explicitly allowlisted with `MISSION_CONTROL_PRIVILEGED_TOOL_ALLOWLIST`.

## Local demo usage

For local demos, no extra configuration is required. The UI continues to work from the browser on the same host.

To enable remote access intentionally, set:

```bash
MISSION_CONTROL_ALLOW_REMOTE=true
MISSION_CONTROL_AUTH_TOKEN=your-secret
```

## Remote access token entry (browser)

When `MISSION_CONTROL_AUTH_TOKEN` is configured and the UI is loaded from a non-loopback address, the server rejects every `/api/*` call (including the CSRF token endpoint) with `401` until the matching `X-Mission-Control-Token` header is supplied. The browser UI (`public/api-client.js`) handles this with an explicit entry flow instead of ever putting the token in a URL:

- The first request that comes back `401` opens a "Remote Access Token Required" modal (`public/index.html` / `app.js`). Concurrent requests share the same prompt instead of opening several.
- The token the operator enters is attached as the `X-Mission-Control-Token` request header on every subsequent `/api/*` call (both reads and mutations). Sending it on a loopback request is harmless — the server only checks it for non-loopback callers.
- The token is kept in memory and, for convenience across a page reload within the same tab, in `sessionStorage` — **never** `localStorage`, a query string, a log line, an exported evidence pack, or rendered as page text. `sessionStorage` is cleared automatically when the browser tab closes.
- The Content-Security-Policy is unchanged (`connect-src 'self'`) — attaching a header to a same-origin request needs no CSP relaxation.
- Known limitation: the incident evidence-pack export buttons use plain navigations, which cannot attach custom headers, so exports remain loopback-only today; they never fall back to a query-string token. The terminal output stream (`EventSource`) *can* be used remotely: `EventSource` itself cannot attach the auth header, so a remote SSE connection to `/api/operations/:id/stream` always fails with a generic transport error — but `app.js` treats that as "stream transport unavailable", not as an operation failure. It closes the `EventSource`, preserves the in-progress operation id, and falls back to authenticated same-origin polling of a plain JSON endpoint (`GET /api/operations/:id?since=N`, via the same `api()` helper used for every other call) for status and incremental log entries until the server reports a genuine terminal status. Only that server-reported status may mark the operation failed. Local/loopback connections keep using `EventSource` directly, since it works there without the auth-header limitation.

## Incident evidence timeline

Every breakable scenario applied via Mission Control (button or Copilot chat) is tracked as a single, per-run "incident" with a unique correlation id. The timeline records scenario activation, server-observed impact, evidence gathered, proposed/approved/denied/expired remediation actions, the action's result, a post-action assertion, and recovery — all with server timestamps, so time-to-detect/root-cause/recover are only ever reported when actually observed.

- State is persisted to `tools/mission-control/.data/incidents.json` (gitignored, non-secret, redacted) so the active run survives a browser refresh or a Mission Control restart.
- `MISSION_CONTROL_INCIDENT_POLL_MS` controls how often the server re-checks cluster health for the active incident (default 5000ms).
- `MISSION_CONTROL_SRE_AGENT_THREAD_URL` and `MISSION_CONTROL_SRE_AGENT_ANALYTICS_URL` optionally link the incident card to the native SRE Agent thread/analytics view. Both are validated (http/https, no embedded credentials) and simply omitted from the UI when unset or invalid — no default/fabricated link is ever shown.
- Redacted Markdown/JSON evidence packs can be exported per incident from `GET /api/incidents/:correlationId/export.md` and `.json` (also available via the panel's export buttons).
- Distributed traces and knowledge-base evidence are not natively wired into this tool set yet; they are reported as "not available" rather than fabricated. See `registerNativeIntegration` in `incident-timeline.js` for the extension point future scenario-analytics work (e.g. issues #19/#23) can use to wire in a real provider.

## Testing

```bash
npm test
```
