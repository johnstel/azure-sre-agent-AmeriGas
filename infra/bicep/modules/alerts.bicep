// =============================================================================
// Alerts Module
// =============================================================================
// Deploys baseline Azure Monitor scheduled query alerts for the AmeriGas Propane
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

var alertActions = {
  actionGroups: actionGroupIds
  customProperties: {
    source: 'azure-sre-agent-sandbox'
    workload: 'amerigas-propane'
  }
}

resource podRestartAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: '${namePrefix}-pod-restarts'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'AmeriGas Propane - Pod restart spike'
    description: 'Triggers quickly when restart activity is detected in the AmeriGas propane namespace.'
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

resource http5xxAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: '${namePrefix}-http-5xx'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'AmeriGas Propane - HTTP 5xx spike'
    description: 'Triggers when 5xx request count increases in AmeriGas propane App Insights logs.'
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

resource podFailureAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: '${namePrefix}-pod-failures'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'AmeriGas Propane - Failed or pending pods'
    description: 'Triggers quickly when failed or pending pods are detected in the AmeriGas propane namespace.'
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

resource crashLoopOomAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: '${namePrefix}-crashloop-oom'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'AmeriGas Propane - CrashLoop/OOM detected'
    description: 'Triggers when CrashLoopBackOff or OOM-related Kubernetes events are detected in the AmeriGas propane namespace.'
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

output podRestartAlertId string = podRestartAlert.id
output http5xxAlertId string = http5xxAlert.id
output podFailureAlertId string = podFailureAlert.id
output crashLoopOomAlertId string = crashLoopOomAlert.id
