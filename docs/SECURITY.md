# Security Findings — ZavaGas Propane SRE Demo Lab

> **Scope**: Full security scan of infrastructure-as-code (Bicep), Kubernetes manifests,
> deployment scripts, and application configuration.
>
> **Date**: 2025-04  
> **Status**: Initial scan — findings tracked below with remediation status.

---

## Summary

| Severity | Total | Fixed | Pending |
|----------|-------|-------|---------|
| Critical | 2 | 2 | 0 |
| High | 3 | 1 | 2 |
| Medium | 4 | 0 | 4 |
| Low | 3 | 0 | 3 |
| **Total** | **12** | **3** | **9** |

---

## Critical Findings

### SEC-001 — Hardcoded RabbitMQ Default Credentials ✅ Fixed

**File**: `k8s/base/application.yaml`  
**Severity**: Critical  
**Status**: ✅ Remediated

**Description**: The RabbitMQ message broker was deployed using well-known default
credentials (`guest` / `guest`) as plaintext environment variables in three separate
deployment manifests (rabbitmq, tank-monitor, order-service). These credentials were
visible to anyone with read access to the repository and to any process with
`kubectl describe pod` access.

**Risk**: An attacker with access to the cluster network could connect to RabbitMQ
using the publicly known default credentials and read or inject messages into the
`tank-events` queue, potentially disrupting tank-level monitoring or injecting fraudulent
delivery orders.

**Remediation Applied**:
- `RABBITMQ_DEFAULT_PASS`, `ORDER_QUEUE_PASSWORD`, and `ORDER_QUEUE_URI` in all three
  deployments now use `secretKeyRef` to read from a Kubernetes Secret named
  `rabbitmq-credentials`.
- `scripts/deploy.ps1` now generates a cryptographically random 24-character password
  at deploy time and stores it in the Secret.
- `scripts/demo-helpers.ps1` `fix-all` ensures the Secret exists (with demo-only defaults
  if not yet generated) before applying the application manifest.

---

### SEC-002 — ACR Admin User Enabled by Default ✅ Fixed

**File**: `infra/bicep/modules/container-registry.bicep`  
**Severity**: Critical  
**Status**: ✅ Remediated

**Description**: The Azure Container Registry module had `adminUserEnabled = true` as the
default value. The admin user creates a shared username/password pair that bypasses Azure
RBAC. These credentials are long-lived, do not expire, and cannot be scoped to individual
principals.

**Risk**: If the admin credentials are extracted (e.g., via `az acr credential show`),
an attacker can push malicious container images to the registry or exfiltrate all images.
The AKS cluster already uses a managed identity with the `AcrPull` role assignment, so
the admin user provides no operational benefit.

**Remediation Applied**:
- Changed the default value of `adminUserEnabled` to `false` in
  `infra/bicep/modules/container-registry.bicep`.
- Comment updated to document the rationale (prefer managed identity over shared credentials).

---

## High Findings

### SEC-003 — Application Insights Connection String Not Marked @secure() ✅ Fixed

**File**: `infra/bicep/modules/sre-agent.bicep`  
**Severity**: High  
**Status**: ✅ Remediated

**Description**: The `appInsightsConnectionString` parameter in the SRE Agent Bicep module
was not decorated with `@secure()`. This means the value may appear in plaintext in
Azure deployment history (accessible via `az deployment group show`) and in ARM template
outputs.

**Risk**: The Application Insights connection string contains the instrumentation key.
Exposure can allow an attacker to ingest telemetry to the App Insights workspace or query
existing telemetry.

**Remediation Applied**:
- Added `@secure()` decorator to the `appInsightsConnectionString` parameter in
  `infra/bicep/modules/sre-agent.bicep`. Bicep treats `@secure()` parameters as sensitive:
  their values are redacted in deployment logs and not stored in deployment state history
  in plaintext.

---

### SEC-004 — Unauthenticated MongoDB Instance ⚠️ Pending

**File**: `k8s/base/application.yaml`  
**Severity**: High  
**Status**: ⚠️ Pending remediation

**Description**: MongoDB is deployed without authentication enabled. Any workload running
in the `propane` namespace (or any namespace if no NetworkPolicy is in place) can connect
to `mongodb:27017` and read or write to any database without credentials.

**Risk**: Any compromised pod in the cluster can read tank readings, customer data, and
delivery records, or corrupt/delete data. In the context of a cascading-failure scenario,
a malicious actor could directly corrupt the `propanedb` database.

**Recommended Remediation**:
1. Add `MONGO_INITDB_ROOT_USERNAME` and `MONGO_INITDB_ROOT_PASSWORD` environment variables
   to the MongoDB deployment, sourced from a Kubernetes Secret (`mongodb-credentials`).
2. Update `ORDER_DB_URI` in order-service to
   `mongodb://propaneadmin:<password>@mongodb:27017/propanedb?authSource=admin`.
3. Create the `mongodb-credentials` Secret in `deploy.ps1` alongside the RabbitMQ secret.

**Workaround for Demo**: Restrict MongoDB access with a Kubernetes NetworkPolicy that
only allows connections from `order-service` pods.

---

### SEC-005 — Key Vault Purge Protection Disabled ⚠️ Pending

**File**: `infra/bicep/modules/key-vault.bicep`  
**Severity**: High  
**Status**: ⚠️ Pending remediation (intentional trade-off for demo)

**Description**: Key Vault is deployed with `enablePurgeProtection` omitted (defaults to
`false`) and `softDeleteRetentionInDays: 7`. This means a Key Vault can be permanently
deleted and secrets irrecoverably lost without the 7-day waiting period that purge
protection enforces.

**Risk**: An accidental or malicious `az keyvault purge` command would permanently destroy
all secrets with no recovery option. The 7-day soft-delete window provides minimal
protection without purge protection.

**Note for Demo**: Purge protection is intentionally disabled to allow repeated
`deploy`/`destroy` cycles during demos. Once enabled, purge protection cannot be disabled,
and the Key Vault name cannot be reused for the retention period. This trade-off is
acceptable for a sandbox environment.

**Recommended Remediation for Production**:
- Set `enablePurgeProtection: true` and increase `softDeleteRetentionInDays` to 30 or more.
- Use unique Key Vault names per deployment (already handled via `uniqueString` suffix).

---

## Medium Findings

### SEC-006 — No Pod SecurityContext on Application Workloads ⚠️ Pending

**File**: `k8s/base/application.yaml` (all deployments)  
**Severity**: Medium  
**Status**: ⚠️ Pending remediation

**Description**: None of the application pod specs define a `securityContext`. This means
containers run with default Linux capabilities, may run as root, and have read-write
access to the container filesystem.

**Risk**: A compromised container has more opportunity to escalate privileges, write to
the filesystem (e.g., to install persistence), or exploit Linux capability abuse.

**Recommended Remediation**: Add the following `securityContext` to each container spec:
```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop:
      - ALL
```
Note: `nginx:alpine` requires a writable `/tmp` and `/var/cache/nginx`; use an emptyDir
volume for those paths or switch to `nginxinc/nginx-unprivileged`.

---

### SEC-007 — No Kubernetes NetworkPolicy for Application Namespace ⚠️ Pending

**File**: `k8s/base/application.yaml`  
**Severity**: Medium  
**Status**: ⚠️ Pending remediation

**Description**: The `propane` namespace has no default-deny NetworkPolicy. Any pod can
connect to any other pod in the namespace (or across namespaces if no cluster-wide policy
exists). The Calico network plugin is installed, so NetworkPolicies are enforced.

**Risk**: A compromised `usage-simulator` or `otel-collector` pod could connect directly
to MongoDB or RabbitMQ without restriction.

**Recommended Remediation**: Add a default-deny NetworkPolicy and explicit allow rules:
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: propane
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
```
Then add per-service allow rules. Note: this is separate from the `deny-tank-monitor`
scenario NetworkPolicy, which is intentionally breakable.

---

### SEC-008 — OpenTelemetry Collector Binding to All Interfaces ⚠️ Pending

**File**: `k8s/base/application.yaml` (otel-collector ConfigMap)  
**Severity**: Medium  
**Status**: ⚠️ Pending remediation

**Description**: The OTel Collector is configured to listen on `0.0.0.0:4317` (OTLP gRPC)
and `0.0.0.0:4318` (OTLP HTTP). While this is normal for in-cluster telemetry collection,
combined with no NetworkPolicy, any pod in any namespace could submit telemetry to the
collector.

**Risk**: Telemetry injection could pollute Application Insights data used by the SRE
Agent for diagnosis, potentially causing false alerts or masking real issues.

**Recommended Remediation**: Restrict OTel Collector ingress via NetworkPolicy to only
allow traffic from pods in the `propane` namespace.

---

### SEC-009 — Key Vault Public Network Access Open to All ⚠️ Pending

**File**: `infra/bicep/modules/key-vault.bicep`  
**Severity**: Medium  
**Status**: ⚠️ Pending remediation (intentional trade-off for demo)

**Description**: Key Vault is deployed with `publicNetworkAccess: 'Enabled'` and
`networkAcls.defaultAction: 'Allow'`. This means the Key Vault data plane is accessible
from any IP address on the internet (subject to RBAC and authentication).

**Risk**: Brute-force attacks on the Key Vault authentication endpoint are possible.
Although RBAC protects secrets from unauthorized access, restricting the network surface
reduces exposure.

**Note for Demo**: Open access is intentional so the dev container and AKS pods can reach
Key Vault without configuring IP allowlists or private endpoints.

**Recommended Remediation for Production**:
- Configure `networkAcls.defaultAction: 'Deny'` with explicit allow rules for the AKS
  subnet and developer IPs.
- Consider enabling a private endpoint for Key Vault.

---

## Low Findings

### SEC-010 — MongoDB Image Version Pinned to Old Minor Version ⚠️ Pending

**File**: `k8s/base/application.yaml`  
**Severity**: Low  
**Status**: ⚠️ Pending remediation

**Description**: MongoDB is deployed using `mongo:4.4`, which reached End of Life (EOL) in
February 2024 and no longer receives security patches. The latest stable release is MongoDB
7.x (LTS).

**Risk**: Known CVEs in MongoDB 4.4 will not be patched in future image updates.

**Recommended Remediation**: Upgrade to `mongo:7.0` or later. Validate that the
order-service makeline-service is compatible with the newer MongoDB wire protocol.

---

### SEC-011 — Container Images Using `:latest` or Floating Tags ⚠️ Pending

**File**: `k8s/base/application.yaml`  
**Severity**: Low  
**Status**: ⚠️ Pending remediation

**Description**: Several deployments use floating image tags (`ghcr.io/azure-samples/...
:latest`), which resolve to different image digests over time. This means:
- Deployments are non-deterministic and not reproducible.
- A supply-chain attack on the upstream image registry could result in a new compromised
  image being pulled silently.

**Affected deployments**: `inventory-service`, `tank-monitor`, `order-service`,
`usage-simulator`, `order-worker`.

**Recommended Remediation**: Pin images to specific digest references, e.g.:
```yaml
image: ghcr.io/azure-samples/aks-store-demo/product-service@sha256:<digest>
```
Or use a specific semver tag (e.g., `1.2.3`) and maintain a Dependabot/Renovate
configuration to keep images up to date.

---

### SEC-012 — Invoke-Expression Usage in Deploy Script ⚠️ Pending

**File**: `scripts/deploy.ps1`  
**Severity**: Low  
**Status**: ⚠️ Pending remediation

**Description**: `deploy.ps1` uses `Invoke-Expression $Command` (aliased in the helper
function `Invoke-AzCliJson`) to execute Azure CLI commands constructed as strings. While
all the string values are generated from validated script inputs, `Invoke-Expression` is
generally discouraged because it evaluates arbitrary PowerShell expressions and can be
exploited through environment variable injection or input manipulation.

**Risk**: Low in the current context because all command strings are constructed
internally from validated parameters. However, it prevents static analysis tools from
flagging unintended injection paths.

**Recommended Remediation**: Replace `Invoke-Expression` with direct `az` invocations
using PowerShell splatting or the `&` call operator with an array of arguments:
```powershell
$result = & az deployment sub create @deployArgs 2>&1 | Out-String
```

---

## Addressed in This PR

| Finding | File | Change |
|---------|------|--------|
| SEC-001 Hardcoded RabbitMQ credentials | `k8s/base/application.yaml`, `scripts/deploy.ps1`, `scripts/demo-helpers.ps1` | Moved to Kubernetes Secret with generated passwords |
| SEC-002 ACR admin user enabled | `infra/bicep/modules/container-registry.bicep` | Default changed to `false` |
| SEC-003 App Insights connection string not @secure() | `infra/bicep/modules/sre-agent.bicep` | Added `@secure()` decorator |

## Pending Issues to Create

The following findings should each be tracked as a separate GitHub Issue for prioritized
remediation:

- [ ] **SEC-004** — Unauthenticated MongoDB (High)
- [ ] **SEC-005** — Key Vault purge protection disabled (High / intentional for demo)
- [ ] **SEC-006** — No pod SecurityContext (Medium)
- [ ] **SEC-007** — No NetworkPolicy default-deny (Medium)
- [ ] **SEC-008** — OTel Collector binds to 0.0.0.0 (Medium)
- [ ] **SEC-009** — Key Vault open to all networks (Medium / intentional for demo)
- [ ] **SEC-010** — MongoDB EOL image (Low)
- [ ] **SEC-011** — Container images with floating tags (Low)
- [ ] **SEC-012** — Invoke-Expression in deploy script (Low)
