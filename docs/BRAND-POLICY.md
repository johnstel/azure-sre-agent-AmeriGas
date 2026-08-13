# Brand Policy — ZavaGas Propane Demo Lab

> ZavaGas and all companies, people, locations, operational data, and incidents in this lab are fictional and used only for demonstration.

This document explains the brand/data policy introduced by issue #27 (rebrand from the real propane company "AmeriGas" to the fictional "ZavaGas"). The **machine-readable source of truth** is [`governance/brand-policy.json`](../governance/brand-policy.json); this document explains it in prose and should be kept in sync with it. Do not duplicate the allowlist/denylist/exclusions here — always point back to that file.

## Display name and slug

| Item | Value |
|---|---|
| Display name (audience-facing) | `ZavaGas` |
| Metadata slug (package names, Kubernetes labels, Azure tags) | `zavagas-propane-demo` |
| Required disclaimer (verbatim, every audience-facing surface) | "ZavaGas and all companies, people, locations, operational data, and incidents in this lab are fictional and used only for demonstration." |

## Canonical fictional partner/site catalog

The single source of truth for every Cylinder Exchange partner/site name, region, route, and capacity is:

**[`tools/mission-control/data/partner-catalog.json`](../tools/mission-control/data/partner-catalog.json)**

Both the customer portal ("Nearby Exchange Locations" section) and the dispatch console (Retail Cage Operations Center) read from this one file at runtime (via the `partner-catalog-config` Kubernetes ConfigMap, generated from it by `scripts/deploy.ps1`). Do not create a second hardcoded array anywhere — always add new sites to that file.

The catalog uses only fictional Microsoft-demo-brand partners (Contoso, Fabrikam, Adventure Works, Northwind Traders, Wide World Importers, Tailspin Toys, Fourth Coffee, Woodgrove) in fictional `Zava-East` / `Zava-Central` / `Zava-North` regions with fictional `Route Z-##` identifiers. These Microsoft sample/demo brands are **not** real-world ZavaGas partners or real companies of any kind — they are reused here only because they are already established, unambiguously fictional names used across Microsoft's own sample data and documentation:

- Contoso — Power BI Regional Sales sample: <https://learn.microsoft.com/power-bi/create-reports/sample-regional-sales>
- Adventure Works and Fabrikam — Dynamics 365 Commerce demo data: <https://learn.microsoft.com/dynamics365/commerce/demo-data>
- Adventure Works — Analysis Services tutorial scenario: <https://learn.microsoft.com/analysis-services/multidimensional-tutorial/analysis-services-tutorial-scenario>
- Northwind Traders — Power Apps sample apps/database: <https://learn.microsoft.com/power-apps/maker/canvas-apps/northwind-install>
- Wide World Importers — SQL sample company: <https://learn.microsoft.com/sql/samples/wide-world-importers-what-is>
- Tailspin Toys — Azure confidential computing scenario: <https://learn.microsoft.com/azure/confidential-computing/use-cases-scenarios>
- Fourth Coffee — Marketplace billing/invoicing example: <https://learn.microsoft.com/marketplace/billing-invoicing>
- Woodgrove — explicitly documented as fictitious: <https://learn.microsoft.com/system-center/scsm/woodgrove-scenario>

## Allowlist

Legitimate platform/vendor/product names that are always permitted (Microsoft, Azure, GitHub, Kubernetes, MongoDB, RabbitMQ, OpenTelemetry, the fictional partner catalog brands above, etc.) — see the full, current list in `governance/brand-policy.json`'s `allowlist` array. This list is intentionally maintained in one place so it can be extended without touching the audit tool's code.

## Denylist

The former real company name (`AmeriGas`) and every real retailer/location named in issue #27's evidence section that was previously embedded in this lab — see the full, current list in `governance/brand-policy.json`'s `denylist` array. Notably:

- `Giant Pottstown` (not the bare word "giant") is denylisted specifically, to avoid false-positiving on ordinary English usage of the word "giant" elsewhere in the repo, while still catching the real Giant Food Stores + Pottstown, PA reference.
- All other denylist terms are specific proper nouns or multi-word phrases (e.g. `Home Depot`, `King of Prussia`) chosen not to collide with unrelated prose.

## Exclusions

The audit tool (`scripts/audit-brand-policy.ps1`) does **not** flag denylist terms found in:

- `.git/` — git internal history and object store. Git history is never rewritten as part of this rebrand.
- `governance/brand-policy.json` and this document — they must legitimately contain the denylisted terms in order to document/check for them.
- `scripts/audit-brand-policy.ps1` and `scripts/tests/audit-brand-policy.tests.ps1` — the tool's own source/tests reference denylist terms in comments and intentionally-injected positive test fixtures.
- Binary files (`*.png`, `*.jpg`, `*.zip`, `*.ico`, …) — not scanned for text content.
- `package-lock.json` and `node_modules/` — third-party dependency metadata/source, not repository-owned content.
- `CHANGELOG.md` (if present) and closed GitHub issue/PR bodies — archival historical records, out of scope for a non-destructive rebrand.

See `governance/brand-policy.json`'s `exclusions` array for the exact, current, machine-readable list.

## Running the audit

```powershell
pwsh scripts/audit-brand-policy.ps1
```

This walks every `git ls-files`-tracked text file (plus any generated demo artifacts under test), applies the allowlist/denylist/exclusions above, and prints a deterministic JSON report with the checked file count, violation count, exclusions applied, and a list of any violations (file, line, term). It exits non-zero if there are unexplained violations. Pass `-PassThru` to get the violations as PowerShell objects instead (used by the Pester tests in `scripts/tests/audit-brand-policy.tests.ps1`).

## Non-destructive tag/label migration

For an **already-deployed** lab that still carries the old `amerigas-propane-demo` tag/labels, use:

```powershell
pwsh scripts/migrate-brand-tags.ps1 -SubscriptionId <sub-id> -ResourceGroupName <rg-name> -WhatIf
```

See `scripts/migrate-brand-tags.ps1`'s comment-based help for full details. It only updates mutable Azure tags and reapplies labeled Kubernetes manifests — it never deletes, renames, or recreates any Azure resource or Kubernetes object identity.

**Known limitation:** there is no live Azure environment available while this policy and its tooling were authored (no `rg-srelab-*` resource group exists in the target subscription). The migration script and Mission Control's resource-group discovery (`tools/mission-control/deployment-scope.js`) are validated with mocked `az` calls and `-WhatIf` dry runs only — they have not been exercised against a live deployment. Validate against a real deployment before relying on them in production.

## Known exclusions / follow-ups

- **`media/menu.png`** — this screenshot shows a generic terminal help menu titled "Azure SRE Agent Demo Lab" with no literal "AmeriGas" text, so it is not a trademark/brand violation. However, its listed commands and services (a `pets` namespace, `order-service`/`product-service`/`makeline-service`, `break-cpu` targeting a "new stress pod") do not match this repository's actual current devcontainer menu or the `propane` namespace services, meaning the image is stale/outdated relative to the current lab regardless of branding. It should be regenerated to reflect the current ZavaGas-branded `menu` command output. Regenerating a screenshot is outside what this rebrand task can produce in this environment.
- **Open GitHub issues** — non-#27 open issue bodies referencing the old brand were updated where `gh issue edit` permissions allowed; see the PR description / final task summary for the exact list of issues updated or skipped.
