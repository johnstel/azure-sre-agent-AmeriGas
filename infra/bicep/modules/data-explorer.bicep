// =============================================================================
// Azure Data Explorer (ADX) Module
// =============================================================================
// Deploys a cost-optimized ADX cluster and database for propane operations log
// analytics. Configures AKS diagnostic settings to send control-plane logs to
// Log Analytics and sets up a Data Export Rule to continuously stream
// ContainerLogV2, KubeEvents, and KubePodInventory tables into ADX.
// =============================================================================

// =============================================================================
// PARAMETERS
// =============================================================================

@description('Name of the Azure Data Explorer cluster')
param clusterName string

@description('Name of the ADX database for propane operations logs')
param databaseName string = 'PropaneLogs'

@description('Azure region for deployment')
param location string

@description('Tags to apply to resources')
param tags object

@description('Full resource ID of the Log Analytics workspace')
param logAnalyticsWorkspaceId string

@description('Full resource ID of the AKS cluster for diagnostic settings')
param aksClusterId string

// =============================================================================
// EXISTING RESOURCES
// =============================================================================

resource aksCluster 'Microsoft.ContainerService/managedClusters@2024-02-01' existing = {
  name: last(split(aksClusterId, '/'))
}

resource logAnalyticsWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: last(split(logAnalyticsWorkspaceId, '/'))
}

// =============================================================================
// RESOURCES
// =============================================================================

// ADX Cluster – Dev SKU with auto-stop for cost savings
resource adxCluster 'Microsoft.Kusto/clusters@2023-08-15' = {
  name: clusterName
  location: location
  tags: tags
  sku: {
    name: 'Dev(No SLA)_Standard_E2a_v4'
    tier: 'Basic'
    capacity: 1
  }
  properties: {
    enableStreamingIngest: true
    enableAutoStop: true
    publicNetworkAccess: 'Enabled'
  }
}

// Propane logs database
resource database 'Microsoft.Kusto/clusters/databases@2023-08-15' = {
  parent: adxCluster
  name: databaseName
  location: location
  kind: 'ReadWrite'
  properties: {
    softDeletePeriod: 'P10D'
    hotCachePeriod: 'P5D'
  }
}

// AKS diagnostic settings – send control-plane logs to Log Analytics
resource aksDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'aks-to-loganalytics'
  scope: aksCluster
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      { categoryGroup: null, category: 'kube-apiserver',            enabled: true }
      { categoryGroup: null, category: 'kube-controller-manager',   enabled: true }
      { categoryGroup: null, category: 'kube-scheduler',            enabled: true }
      { categoryGroup: null, category: 'kube-audit-admin',          enabled: true }
      { categoryGroup: null, category: 'guard',                     enabled: true }
      { categoryGroup: null, category: 'cloud-controller-manager',  enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

// Log Analytics Data Export Rule – stream key tables to ADX
resource dataExportRule 'Microsoft.OperationalInsights/workspaces/dataExports@2020-08-01' = {
  parent: logAnalyticsWorkspace
  name: 'export-to-adx'
  properties: {
    destination: {
      resourceId: adxCluster.id
    }
    tableNames: [
      'ContainerLogV2'
      'KubeEvents'
      'KubePodInventory'
    ]
    enable: true
  }
}

// =============================================================================
// OUTPUTS
// =============================================================================

output clusterId string = adxCluster.id
output clusterUri string = adxCluster.properties.uri
output databaseName string = database.name
