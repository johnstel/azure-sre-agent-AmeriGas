// =============================================================================
// Alerts Module
// =============================================================================
// Deploys baseline Azure Monitor scheduled query alerts for the ZavaGas Propane
// platform. These alerts can be connected to action groups for paging/incident
// workflows.
// =============================================================================

@description('Prefix used for alert names')
param namePrefix string

@description('Azure region for deployment')
param location string

@description('Tags to apply to resources')
param tags object

@description('Log Analytics workspace resource ID')
param logAnalyticsWorkspaceId string

@description('Application namespace to monitor')
param appNamespace string = 'propane'

@description('Optional action group resource IDs for alert notifications')
param actionGroupIds array = []

@description('Deploy the four baseline alerts (pod restarts, HTTP 5xx, pod failures, CrashLoop/OOM). Kept as its own switch so the demo-only MongoDB-down alert below can be deployed independently, satisfying "enable only the minimum required alert plumbing in a demo profile" even when the general-purpose alert set is off.')
param deployStandardAlerts bool = true

@description('Deploy the dedicated demo-profile MongoDB-down alert (issue #19). Off by default — the standard profile never enables this even when deployStandardAlerts=true; only the demo profile (main.demo.bicepparam) turns it on.')
param deployMongoDbDownDemoAlert bool = false

@description('Deterministic display title for the demo MongoDB-down alert. The Azure SRE Agent response plan (bootstrap-sre-agent-response-plan.ps1) filters incidents on this exact title plus the severity below, so it must stay in sync with that script and with docs/sre-agent-response-plans.')
param mongoDbDownDemoAlertTitle string = 'ZavaGas Propane Demo - MongoDB Down'

@description('Severity for the demo MongoDB-down alert (0=critical .. 4=verbose). Must match the severity filter configured in the bootstrapped response plan.')
@minValue(0)
@maxValue(4)
param mongoDbDownDemoAlertSeverity int = 1

var alertActions = {
  actionGroups: actionGroupIds
  customProperties: {
    source: 'azure-sre-agent-sandbox'
    workload: 'zavagas-propane'
  }
}

resource podRestartAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = if (deployStandardAlerts) {
  name: '${namePrefix}-pod-restarts'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'ZavaGas Propane - Pod restart spike'
    description: 'Triggers quickly when restart activity is detected in the ZavaGas propane namespace.'
    enabled: true
    severity: 2
    scopes: [
      logAnalyticsWorkspaceId
    ]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT1M'
    autoMitigate: true
    skipQueryValidation: true
    criteria: {
      allOf: [
        {
          query: 'KubePodInventory | where TimeGenerated > ago(2m) | where Namespace == "${appNamespace}" | where ContainerRestartCount > 0'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: alertActions
  }
}

resource http5xxAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = if (deployStandardAlerts) {
  name: '${namePrefix}-http-5xx'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'ZavaGas Propane - HTTP 5xx spike'
    description: 'Triggers when 5xx request count increases in ZavaGas propane App Insights logs.'
    enabled: true
    severity: 1
    scopes: [
      logAnalyticsWorkspaceId
    ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT10M'
    autoMitigate: true
    skipQueryValidation: true
    criteria: {
      allOf: [
        {
          query: 'AppRequests | where TimeGenerated > ago(10m) | where toint(ResultCode) >= 500'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 20
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: alertActions
  }
}

resource podFailureAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = if (deployStandardAlerts) {
  name: '${namePrefix}-pod-failures'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'ZavaGas Propane - Failed or pending pods'
    description: 'Triggers quickly when failed or pending pods are detected in the ZavaGas propane namespace.'
    enabled: true
    severity: 2
    scopes: [
      logAnalyticsWorkspaceId
    ]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT1M'
    autoMitigate: true
    skipQueryValidation: true
    criteria: {
      allOf: [
        {
          query: 'KubePodInventory | where TimeGenerated > ago(2m) | where Namespace == "${appNamespace}" | where PodStatus in ("Failed", "Pending")'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: alertActions
  }
}

resource crashLoopOomAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = if (deployStandardAlerts) {
  name: '${namePrefix}-crashloop-oom'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'ZavaGas Propane - CrashLoop/OOM detected'
    description: 'Triggers when CrashLoopBackOff or OOM-related Kubernetes events are detected in the ZavaGas propane namespace.'
    enabled: true
    severity: 1
    scopes: [
      logAnalyticsWorkspaceId
    ]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT1M'
    autoMitigate: true
    skipQueryValidation: true
    criteria: {
      allOf: [
        {
          query: 'KubeEvents | where TimeGenerated > ago(2m) | where Namespace == "${appNamespace}" | where Reason in ("BackOff", "OOMKilled", "CrashLoopBackOff")'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: alertActions
  }
}

// =============================================================================
// Demo profile — MongoDB Down response-plan alert (issue #19)
// =============================================================================
// A dedicated alert distinct from crashLoopOomAlert above: scaling the
// mongodb Deployment to 0 replicas (k8s/scenarios/mongodb-down.yaml) removes
// the pod entirely rather than putting it into Failed/Pending/CrashLoop/OOM
// state, so none of the four generic alerts above ever fire for it. This
// alert explicitly counts distinct *Running* mongodb pods in the propane
// namespace and fires when that count is zero.
//
// Bounded/deterministic timing: PT1M evaluation frequency + Log Analytics
// Container Insights ingestion latency (typically 2-5 minutes) means this
// alert is expected to fire within approximately 10 minutes of the scenario
// being applied — see docs/BREAKABLE-SCENARIOS.md and
// docs/sre-agent-response-plans/README.md for the documented bound and how
// to verify it during rehearsal.
resource mongoDbDownDemoAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = if (deployMongoDbDownDemoAlert) {
  name: '${namePrefix}-demo-mongodb-down'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: mongoDbDownDemoAlertTitle
    description: 'Demo-only alert (issue #19): fires when zero Running mongodb pods are found in the ZavaGas propane namespace, indicating the tank/order database is offline (e.g. k8s/scenarios/mongodb-down.yaml scaled the Deployment to 0 replicas). Bound to a single Azure SRE Agent response plan by exact title + severity match — do not rename without updating scripts/bootstrap-sre-agent-response-plan.ps1.'
    enabled: true
    severity: mongoDbDownDemoAlertSeverity
    scopes: [
      logAnalyticsWorkspaceId
    ]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    autoMitigate: true
    skipQueryValidation: true
    criteria: {
      allOf: [
        {
          query: 'KubePodInventory | where TimeGenerated > ago(5m) | where Namespace == "${appNamespace}" | where Name startswith "mongodb" | where PodStatus == "Running" | summarize RunningCount = dcount(Name) | where RunningCount == 0'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: alertActions
  }
}

output podRestartAlertId string = deployStandardAlerts ? podRestartAlert!.id : ''
output http5xxAlertId string = deployStandardAlerts ? http5xxAlert!.id : ''
output podFailureAlertId string = deployStandardAlerts ? podFailureAlert!.id : ''
output crashLoopOomAlertId string = deployStandardAlerts ? crashLoopOomAlert!.id : ''
output mongoDbDownDemoAlertId string = deployMongoDbDownDemoAlert ? mongoDbDownDemoAlert!.id : ''
output mongoDbDownDemoAlertTitleUsed string = mongoDbDownDemoAlertTitle
output mongoDbDownDemoAlertSeverityUsed int = mongoDbDownDemoAlertSeverity
