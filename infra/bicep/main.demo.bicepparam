// =============================================================================
// Bicep Parameters File - AmeriGas Propane SRE Agent DEMO Profile (issue #19)
// =============================================================================
// Version-controlled demo profile: enables ONLY the minimum plumbing needed
// for the native alert-to-approved-remediation response plan (the dedicated
// MongoDB-down alert, Azure Monitor incident connection, and the least-scope
// custom RBAC role for `az aks command invoke`) on top of the same baseline
// as main.bicepparam. The standard profile (main.bicepparam) is completely
// unaffected by this file — deployDemoResponsePlan defaults to false there
// and this file is never implicitly picked up.
//
// Deploy with:
//   az deployment sub create --location eastus2 \
//     --template-file main.bicep --parameters main.demo.bicepparam
// or:
//   .\scripts\deploy.ps1 -Location eastus2 -Demo
// =============================================================================

using 'main.bicep'

// Core parameters are passed by scripts/deploy.ps1 via --parameters

// Observability stack (Grafana + Prometheus)
param deployObservability = true

// Baseline alert rules — required so the demo MongoDB-down alert has
// somewhere to run alongside; deployDemoResponsePlan below adds exactly one
// additional dedicated alert on top of these four.
param deployAlerts = true

// Deploy Azure SRE Agent (programmatic deployment now supported)
param deploySreAgent = true

// Enable the demo alert-to-approved-remediation response plan wiring:
// the dedicated MongoDB-down alert, incidentManagementConfiguration=AzMonitor
// on the agent, and the least-scope custom RBAC role scoped to the AKS
// cluster resource for the response plan's `az aks command invoke` action.
param deployDemoResponsePlan = true

// Default action group for incident routing — left off. Azure Monitor
// connects to the SRE Agent directly via incidentManagementConfiguration;
// this demo does not require an action group webhook pointed at the agent.
param deployActionGroup = false

// AKS Configuration - cost-optimized for demo
param kubernetesVersion = '1.32'
param systemNodeVmSize = 'Standard_D2s_v5'
param userNodeVmSize = 'Standard_D2s_v5'
param systemNodeCount = 2
param userNodeCount = 3

// Tags
param tags = {
  workload: 'amerigas-propane-demo'
  environment: 'demo'
  managedBy: 'bicep'
  purpose: 'propane-sre-demo'
  costCenter: 'propane-demo-lab'
  SecurityControl: 'Ignore'
}
