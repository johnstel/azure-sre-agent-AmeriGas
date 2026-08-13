# Proactive Daily Health-Report Scheduled Task (issue #24)

This directory holds the version-controlled artifacts for the native Azure
SRE Agent **scheduled task** `daily-propane-health-report`, implemented for
[issue #24](https://github.com/johnstel/azure-sre-agent-AmeriGas/issues/24):
a genuine, native, recurring Azure SRE Agent automation — **not** a cron
job, **not** a GitHub Action, **not** Mission Control Copilot, and **not**
a manual portal click.

> **Status: configuration is semantically verified; a live scheduled/RunNow
> execution and its report are still pending in this environment.**
> `scripts/bootstrap-sre-agent-scheduled-task.ps1 -Action Bootstrap` and
> `-Action Validate` prove the task is written AND that the platform's own
> data-plane read interprets it with the correct fields (Daily schedule,
> Autonomous autonomy, the exact versioned prompt hash). **That is not the
> same as proving a real execution has produced a real Healthy / Degraded
> / Insufficient-evidence report.** Run `-Action RunNow` (or wait for the
> daily schedule) and `-Action History` against a live deployment before
> describing the proactive-monitoring story as demonstrated.

## Files

| File | Purpose |
|------|---------|
| `daily-propane-health-report-prompt.md` | The versioned natural-language task prompt AND its expected output contract (executive summary, evidence table, prioritized next actions, exactly one of `Healthy`/`Degraded`/`Insufficient evidence`). `scripts/bootstrap-sre-agent-scheduled-task.ps1` renders its `{{...}}` placeholders and SHA-256 hashes the result for drift detection. |
| `scripts/bootstrap-sre-agent-scheduled-task.ps1` | Idempotent create/update/validate/run-now/history/teardown for the scheduled task through the data-plane `extendedAgent/scheduledtasks` endpoint. |
| `scripts/tests/bootstrap-sre-agent-scheduled-task.tests.ps1` | Unit tests (mocked HTTP) for every function. |
| `scripts/tests/bootstrap-sre-agent-scheduled-task-http.tests.ps1` | Real-HTTP-listener tests proving header/body/BOM/token-secrecy behavior for every verb used (GET/PUT/PATCH/POST/DELETE). |
| `tools/mission-control/scheduled-task-evidence.js` | Server-side trusted evidence store consumed by the Mission Control presenter `scheduled-task` gate (see "Presenter gate integration" below). |

## What "read-only but Autonomous" means here

The task never proposes or executes a write action — every check
(Resource Health, AKS state, restarts/warnings, Application Insights
trends, active alerts) is a read. Because there is nothing for a human to
approve, the task is configured with `agentAutonomyLevel: Autonomous` (see
[run modes](https://learn.microsoft.com/azure/sre-agent/run-modes): "Set
run modes per response plan and per scheduled task ... Daily health checks
[recommended mode]: Autonomous"). This is a different, narrower guarantee
than the incident response plan (issue #19), which hard-codes `Review`
because it proposes a real remediation action.

## API evidence and what is/isn't officially documented

Per <https://learn.microsoft.com/azure/sre-agent/api-reference>
("Extended agent configuration"):

> Scheduled tasks | `/api/v2/extendedAgent/scheduledtasks/{name}` ...
> All resources support `PUT`, `GET`, `PATCH`, and `DELETE` methods.

The **path and verbs** are officially documented; the **request/response
body schema** is not. `New-ScheduledTaskDataPlaneSpec` in the bootstrap
script is a best-effort mapping from the documented portal workflow
(<https://learn.microsoft.com/azure/sre-agent/create-scheduled-task>: task
name, task details, frequency, time of day, response custom agent, message
grouping, agent autonomy level) — every write is followed by a semantic
re-read that compares the platform's own interpreted fields against what
was sent, exactly like `bootstrap-sre-agent-response-plan.ps1`. A silently
dropped/reinterpreted field surfaces as `SchemaMismatch`, never a false
success.

**Capability detection.** The single-item data-plane path 404s both when
the task doesn't exist yet and when the whole capability is unsupported —
an ambiguity the response-plan script's design explicitly warns about. This
script instead probes the ARM **control-plane collection-level GET** on the
`scheduledTasks` sub-resource type (no item name), which follows standard
ARM resource-provider convention: HTTP 200 with an empty `value: []` when
the type exists but has no items, and a confirmed 404 only when the type
itself is unavailable. A confirmed 404/405 there is reported as
`UnsupportedApi` and the script makes **zero** write calls.

**RunNow is entirely unpublished.** Microsoft's own docs mention only a
portal button ("Test with 'Run task now'" —
<https://learn.microsoft.com/azure/sre-agent/workflow-automation>), with no
documented REST path. `-Action RunNow` probes two plausible candidate paths
(`.../run`, `.../execute`) and reports `UnsupportedApi` — recommending the
portal button instead — if both 404/405. It never fabricates a thread or a
report. A successful trigger polls the **documented** thread endpoints
(`GET /api/v1/threads/{id}`, `GET /api/v1/threads/{id}/messages`), bounded
to 5 minutes.

**History is a best-effort heuristic.** The documented `GET
/api/v1/threads` list has no publish filter-by-task-name parameter (per
<https://learn.microsoft.com/azure/sre-agent/threads>, "Scheduled task: A
scheduled task runs and creates a thread for its output" — but no field
name is given for filtering). `-Action History` filters client-side by
thread title containing the task name and reports this as a heuristic, not
a guaranteed exact match.

## Running it

```powershell
# Create or update (idempotent)
.\scripts\bootstrap-sre-agent-scheduled-task.ps1 -ResourceGroupName rg-srelab-eastus2 -AgentName sre-srelab -AksClusterName aks-srelab

# Validate without writing anything
.\scripts\bootstrap-sre-agent-scheduled-task.ps1 -ResourceGroupName rg-srelab-eastus2 -AgentName sre-srelab -AksClusterName aks-srelab -Action Validate

# Trigger an out-of-schedule execution and wait (bounded to 5 minutes) for the report
.\scripts\bootstrap-sre-agent-scheduled-task.ps1 -ResourceGroupName rg-srelab-eastus2 -AgentName sre-srelab -AksClusterName aks-srelab -Action RunNow

# List/inspect prior executions
.\scripts\bootstrap-sre-agent-scheduled-task.ps1 -ResourceGroupName rg-srelab-eastus2 -AgentName sre-srelab -AksClusterName aks-srelab -Action History

# Remove only this lab's task
.\scripts\bootstrap-sre-agent-scheduled-task.ps1 -ResourceGroupName rg-srelab-eastus2 -AgentName sre-srelab -AksClusterName aks-srelab -Action Teardown
```

## Presenter gate integration (issue #20)

Mission Control's Deep Dive presenter track includes a `scheduled-task`
gate step. Before this change it trusted a bare `scheduledTaskAvailable`
boolean with no way to verify it came from a real execution.
`tools/mission-control/scheduled-task-evidence.js` replaces that with a
structured, server-recorded contract: exact task id, prompt version hash,
thread id, timestamp, and outcome status. Evidence is recorded ONLY through
the authenticated `POST /api/scheduled-task/evidence` route (same operator
authentication as `/api/approval`) — never accepted as a client-supplied
boolean, and freshness/outcome are re-evaluated live on every gate check
(a record made hours ago correctly becomes stale even if nobody calls the
endpoint again). An `Insufficient evidence` outcome **never** unlocks the
gate, even if fresh — matching issue #24's "missing/stale telemetry must
never be reported as ready" requirement.

The gate also reads `tools/mission-control/.data/telemetry-proof.json`, which is
written atomically only after `scripts/validate-telemetry.ps1` proves fresh
`AppRequests`, `AppDependencies`, `AppExceptions`, `AppTraces`, `AppMetrics`,
and a correlated `KubeEvents` record. A missing, stale (older than five
minutes), incomplete, or mismatched telemetry proof keeps readiness blocked
regardless of the scheduled task's reported status.

First generate fresh telemetry proof, then record real evidence after a
rehearsal `-Action RunNow`:

```powershell
.\scripts\validate-telemetry.ps1 -ResourceGroupName <resource-group>
```

```bash
curl -X POST http://127.0.0.1:3000/api/scheduled-task/evidence \
  -H "Content-Type: application/json" \
  -H "X-Mission-Control-Operator-Token: <operator token>" \
  -d '{
        "taskId": "daily-propane-health-report",
        "promptVersionHash": "<hash printed by -Action Bootstrap>",
        "threadId": "<thread id printed by -Action RunNow>",
        "timestamp": "<UTC ISO timestamp of the completed run>",
        "status": "Healthy"
      }'
```

## Presenter segment (~90 seconds)

1. **(15s)** Open the SRE Agent portal's **Scheduled tasks** list. Point out
   `daily-propane-health-report`: schedule (Daily), status (On), last/next
   run.
2. **(30s)** Select the task name to open its execution history. Open the
   most recent completed thread and scroll to the four required sections:
   executive summary, evidence table (with per-row freshness), prioritized
   next actions, and the exact `Overall status:` line.
3. **(20s)** Select **Run task now** live, and narrate what the agent is
   checking while it plans (Resource Health, AKS state, 24h restarts/
   warnings, Application Insights trends, active alerts).
4. **(15s)** Land on the punch line: this ran on a schedule, with full
   audit history, using the SAME natural-language prompt checked into this
   repository — nobody had to write or maintain a script.
5. **(10s)** If telemetry is intentionally broken for the demo, show the
   `Insufficient evidence` outcome and note that this is exactly what
   prevents a false "all clear."

**Live validation pending.** This presenter segment and the
healthy/degraded/insufficient-evidence rehearsal below have not yet been
run against a live deployment in this environment; do not present this as
"tested end-to-end" until they have.

## Validation runbook (healthy / degraded / insufficient evidence)

Run all three, exactly as the issue's acceptance criteria require:

1. **Healthy.** With `k8s/base/application.yaml` applied and no scenario
   active, run `-Action RunNow`. Expect `Overall status: Healthy`.
2. **Degraded.** Apply any breakable scenario (for example
   `k8s/scenarios/oom-killed.yaml`), then run `-Action RunNow`. Expect
   `Overall status: Degraded`, with the evidence table identifying the
   affected service WITHOUT being told the scenario name.
3. **Insufficient evidence.** Temporarily make Application Insights
   telemetry unavailable (for example, remove/misconfigure the connection
   string) and run `-Action RunNow`. Expect `Overall status: Insufficient
   evidence` — never `Healthy` — and confirm the Mission Control presenter
   gate correctly reports the readiness signal as failed (not unlocked).

After each run, restore the healthy baseline with
`kubectl apply -f k8s/base/application.yaml` before the next variant.
