# Mission Control hardening

Mission Control now binds to loopback by default and requires a CSRF token for state-changing requests.

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

## Testing

```bash
npm test
```
