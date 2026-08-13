# Repository Rename Checklist (Optional, Owner-Only)

This is documentation only. Nothing in this checklist is executed by, or required for, the ZavaGas rebrand (issue #27) to be considered code-complete. Renaming the GitHub repository itself is an **administrative decision for the repository owner**, entirely separate from the application/infrastructure code changes.

> ZavaGas and all companies, people, locations, operational data, and incidents in this lab are fictional and used only for demonstration.

## Why this is optional and separate

- The current repository name (`azure-sre-agent-AmeriGas`) still references the old brand, but GitHub repository names, issue/PR history, and git history are explicitly **out of scope** for this code change (see issue #27's "Dependencies and non-goals": *"Repository, issue, PR, and git-history renames/rewrites are administrative or archival decisions outside the code PR."*).
- All application-facing branding (portals, Mission Control, docs, IaC metadata, scripts) has already been rebranded to `ZavaGas` in code. The repository's GitHub-hosted name is the last remaining place the old brand appears, and it requires an owner decision (new name, redirects, downstream link impact) rather than a code change.

## If the repository owner decides to rename

1. **Pick a new repository name.** A natural choice consistent with this rebrand would be something like `azure-sre-agent-ZavaGas` or `azure-sre-agent-zavagas-demo`, but the owner may choose any name.
2. **Rename via GitHub Settings → General → Repository name** (or `gh repo rename <new-name>`). GitHub automatically creates a redirect from the old name to the new one for most operations (web UI, git clone/fetch/push, API calls), but:
   - Existing `git remote` URLs on contributors' local clones will keep working via the redirect, but contributors should update their remotes (`git remote set-url origin <new-url>`) at their convenience.
   - CI/CD systems, deploy hooks, external documentation, and any hardcoded links to the old repository URL should be updated explicitly — do not rely solely on GitHub's redirect indefinitely.
3. **Update any external references** the owner controls: bookmarks, wiki links, internal documentation, Copilot Space configuration, or other tooling that hardcodes the repository's `owner/repo` string.
4. **Do not** rewrite git history, force-push, or delete/recreate the repository as part of this — a rename preserves all commits, branches, issues, and PRs exactly as they are.
5. **Do not** attempt to rename or edit the body of already-closed issues/PRs to scrub the old brand name — those are archival historical records, explicitly excluded from this rebrand's scope (see `docs/BRAND-POLICY.md`'s exclusions).
6. Optionally, update the local devcontainer's `.devcontainer/devcontainer.json` `name` field if the owner wants it to exactly match the new repository name (it currently reads `ZavaGas Propane SRE Demo Lab`, which does not need to change even after a repository rename, since it already uses the fictional brand).

## What does NOT require a repository rename

- Everything covered by issue #27's code scope (portals, Mission Control, IaC metadata, scripts, docs, governance policy) is already rebranded and does not depend on the GitHub repository's name.
- Azure resource names (`rg-srelab-*`, `aks-srelab`) and the Kubernetes `propane` namespace are intentionally brand-neutral already and are never touched by a repository rename.
