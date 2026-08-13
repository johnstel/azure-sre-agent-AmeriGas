<!--
Version: 1
Task name: daily-propane-health-report

This file is the SINGLE SOURCE OF TRUTH for the scheduled task's natural
language prompt (task details) and its expected output contract. It is
rendered by scripts/bootstrap-sre-agent-scheduled-task.ps1, which:
  - Substitutes the {{...}} placeholders below with the actual deployed
    subscription/resource group/AKS cluster name.
  - SHA-256 hashes the RENDERED content (see Get-ScheduledTaskPromptHash in
    that script) so `-Action Validate` can detect a drift between what is
    checked in here and what is actually configured on the live task
    without ever comparing opaque byte envelopes.
  - Never mutates this file — it is read-only input.

Bump "Version" above whenever the prompt text changes; the bootstrap script
records the version alongside the hash so a rerun after a prompt edit is
recognized as an intentional update (not configuration drift) and produces
exactly one PATCH.
-->

# Task details (verbatim prompt sent to the agent)

Review the operational health of the ZavaGas propane distribution platform
in resource group {{RESOURCE_GROUP}} (subscription {{SUBSCRIPTION_ID}}),
AKS cluster {{AKS_CLUSTER_NAME}}, namespace `propane`. This is a read-only
review — do not take, propose, or request approval for any write action.

Check, in order:

1. **Azure Resource Health** for the AKS cluster and its node pools.
2. **AKS cluster/node/workload state** — compare desired vs. available
   replicas for every Deployment/StatefulSet in the `propane` namespace, and
   node Ready condition for every node.
3. **Restarts and warning events in the last 24 hours** — any pod restarts,
   `Warning`-type Kubernetes events, OOMKilled, CrashLoopBackOff, or
   ImagePullBackOff in the `propane` namespace.
4. **Application Insights error rate and latency (p95) trends** — only using
   telemetry with a timestamp inside the last 24 hours. If Application
   Insights returns no data, or every sample is older than 24 hours, treat
   the corresponding evidence rows as missing — do not estimate, interpolate,
   or carry forward an older value.
5. **Active alerts** on this resource group's Azure Monitor alert rules.
6. **Baseline comparison** — if memory contains a prior run's summary for
   this exact task, compare each metric above to that baseline and call out
   any regression; if no prior baseline exists yet, say so explicitly
   instead of inventing one.

## Required output format (produce all four sections, in this order)

1. **Executive summary** — 2-4 sentences, no jargon, stating the overall
   status and the single most important finding.
2. **Evidence table** — one row per check above, with columns: `Source`,
   `Finding`, `Timestamp (UTC)`, `Freshness` (`fresh` if the underlying
   telemetry/state is less than 24 hours old, `stale` if 24-48 hours old,
   `missing` if no data was returned or every sample exceeds 48 hours old).
3. **Prioritized next actions** — a numbered list, most urgent first; if
   nothing is actionable, state that explicitly rather than omitting the
   section.
4. **Overall status** — exactly one of the following three labels, on its
   own line, formatted as `Overall status: <label>`:
   - `Healthy` — every check above returned fresh, in-range evidence and no
     regression against baseline.
   - `Degraded` — fresh evidence was returned and at least one check shows
     an active problem (restarts, warnings, elevated errors/latency, an
     active alert, or a regression against baseline).
   - `Insufficient evidence` — any required check above could not be
     completed, returned no data, or every sample for that check exceeds 48
     hours old. **This label is mandatory whenever telemetry is missing or
     stale — never report `Healthy` or `Degraded` by omitting or working
     around a missing/stale source.**

Do not use any other status label, and do not combine two labels. If a
single check is missing/stale but every other check is otherwise healthy,
the overall status is still `Insufficient evidence`, not `Healthy`.
