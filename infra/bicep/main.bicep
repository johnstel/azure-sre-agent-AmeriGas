// =============================================================================
// Azure SRE Agent AmeriGas Propane Demo Lab - Main Bicep Template
// =============================================================================
// This template deploys an AKS cluster with a multi-pod propane distribution platform,
// along with supporting infrastructure for demonstrating Azure SRE Agent
// capabilities for diagnostics and troubleshooting.
// =============================================================================

targetScope = 'subscription'

// =============================================================================
// PARAMETERS
// =============================================================================

@description('Name of the workload (used for naming resources)')
@minLength(3)
@maxLength(10)
param workloadName string = 'srelab'

@description('Azure region for deployment. Must be a region supporting SRE Agent (East US 2, Sweden Central, Australia East)')
@allowed([
  'eastus2'
  'swedencentral'
  'australiaeast'
])
param location string = 'eastus2'

@description('Deploy full observability stack (Managed Grafana, Prometheus)')
param deployObservability bool = true

@description('Deploy baseline Azure Monitor alert rules for AKS and app telemetry')
param deployAlerts bool = false

@description('Deploy Azure SRE Agent for AI-powered diagnostics and remediation')
param deploySreAgent bool = true

@description('Pinned Microsoft.App/agents control-plane API version. scripts/deploy.ps1 detects the newest version supported by the target subscription via the resource-provider metadata and passes it here; it fails deployment rather than silently degrading when neither version is registered.')
@allowed([
  '2026-01-01'
  '2025-05-01-preview'
])
param sreAgentApiVersion string = '2026-01-01'

@description('Deploy Azure Data Explorer cluster for propane operations log analytics (optional — SRE Agent uses Log Analytics directly)')
param deployDataExplorer bool = false

@description('Deploy default Action Group for alert notifications and incident routing')
param deployActionGroup bool = false

@description('Action Group short name (max 12 characters)')
@maxLength(12)
param actionGroupShortName string = 'srelabops'

@secure()
@description('Optional webhook/Logic App callback URL for default Action Group incident routing')
param incidentWebhookServiceUri string = ''

@description('Optional action group resource IDs to notify when alerts fire')
param alertActionGroupIds array = []

@description('Deploy the dedicated demo alert-to-approved-remediation response plan wiring for the MongoDB-down scenario (issue #19): the demo MongoDB-down alert, incidentManagementConfiguration=AzMonitor, and the least-scope custom RBAC role for `az aks command invoke`. Off by default — the standard profile (main.bicepparam) never enables this; only main.demo.bicepparam does. Requires deployAlerts=true and deploySreAgent=true.')
param deployDemoResponsePlan bool = false

@description('Explicit operator acknowledgement that the demo response plan requires granting the built-in Monitoring Contributor role to the SRE Agent managed identity at SUBSCRIPTION scope. This is not a design choice — Microsoft documents this as the minimum scope required for the Azure Monitor alert scanner to discover and manage alert lifecycle (see https://learn.microsoft.com/azure/sre-agent/azure-monitor-alerts and https://learn.microsoft.com/azure/sre-agent/agent-permissions). Must be explicitly set true (never implied by deployDemoResponsePlan alone) for infra/bicep/modules/sre-agent-monitoring-rbac.bicep to deploy; scripts/deploy.ps1 requires a separate -AcceptSubscriptionScopeMonitoringRbac switch before it will pass this as true. Off by default; the standard profile never sets this.')
param acknowledgeSubscriptionScopeMonitoringRbac bool = false

@description('AKS Kubernetes version')
param kubernetesVersion string = '1.32'

@description('AKS system node pool VM size')
@allowed([
  'Standard_D2s_v5'
  'Standard_D4s_v5'
  'Standard_D2as_v5'
  'Standard_D4as_v5'
])
param systemNodeVmSize string = 'Standard_D2s_v5'

@description('AKS user node pool VM size for workloads')
@allowed([
  'Standard_D2s_v5'
  'Standard_D4s_v5'
  'Standard_D2as_v5'
  'Standard_D4as_v5'
])
param userNodeVmSize string = 'Standard_D2s_v5'

@description('System node pool node count')
@minValue(1)
@maxValue(5)
param systemNodeCount int = 2

@description('User node pool node count')
@minValue(1)
@maxValue(10)
param userNodeCount int = 3

@description('Tags to apply to all resources')
param tags object = {
  workload: 'amerigas-propane-demo'
  environment: 'sandbox'
  managedBy: 'bicep'
  purpose: 'propane-sre-demo'
  SecurityControl: 'Ignore'
}

// =============================================================================
// VARIABLES
// =============================================================================

var resourceGroupName = 'rg-${workloadName}-${location}'
var uniqueSuffix = uniqueString(subscription().subscriptionId, resourceGroupName)

// Naming convention for resources
var names = {
  aks: 'aks-${workloadName}'
  acr: 'acr${workloadName}${take(uniqueSuffix, 6)}'
  logAnalytics: 'log-${workloadName}'
  appInsights: 'appi-${workloadName}'
  grafana: 'grafana-${workloadName}-${take(uniqueSuffix, 6)}'
  prometheus: 'prometheus-${workloadName}'
  keyVault: 'kv-${workloadName}-${take(uniqueSuffix, 6)}'
  managedIdentity: 'id-${workloadName}'
  vnet: 'vnet-${workloadName}'
  sreAgent: 'sre-${workloadName}'
  adx: 'adx-${workloadName}-${take(uniqueSuffix, 6)}'
}

// =============================================================================
// RESOURCE GROUP
// =============================================================================

resource resourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: union(tags, { SecurityControl: 'Ignore' })
}

// =============================================================================
// MODULES
// =============================================================================

// Log Analytics Workspace (required for AKS monitoring and SRE Agent)
module logAnalytics 'modules/log-analytics.bicep' = {
  scope: resourceGroup
  name: 'deploy-log-analytics'
  params: {
    name: names.logAnalytics
    location: location
    tags: tags
    retentionInDays: 30
  }
}

// Application Insights (for application-level telemetry)
module appInsights 'modules/app-insights.bicep' = {
  scope: resourceGroup
  name: 'deploy-app-insights'
  params: {
    name: names.appInsights
    location: location
    tags: tags
    workspaceId: logAnalytics.outputs.workspaceId
  }
}

// Virtual Network for AKS
module network 'modules/network.bicep' = {
  scope: resourceGroup
  name: 'deploy-network'
  params: {
    vnetName: names.vnet
    location: location
    tags: tags
    addressPrefix: '10.0.0.0/16'
    aksSubnetPrefix: '10.0.0.0/22'
    servicesSubnetPrefix: '10.0.4.0/24'
  }
}

// Azure Container Registry
module containerRegistry 'modules/container-registry.bicep' = {
  scope: resourceGroup
  name: 'deploy-acr'
  params: {
    name: names.acr
    location: location
    tags: tags
    sku: 'Basic'
  }
}

// Azure Kubernetes Service
module aks 'modules/aks.bicep' = {
  scope: resourceGroup
  name: 'deploy-aks'
  params: {
    name: names.aks
    location: location
    tags: tags
    kubernetesVersion: kubernetesVersion
    systemNodeVmSize: systemNodeVmSize
    userNodeVmSize: userNodeVmSize
    systemNodeCount: systemNodeCount
    userNodeCount: userNodeCount
    vnetSubnetId: network.outputs.aksSubnetId
    logAnalyticsWorkspaceId: logAnalytics.outputs.workspaceId
    acrId: containerRegistry.outputs.acrId
  }
}

// Key Vault for secrets management
module keyVault 'modules/key-vault.bicep' = {
  scope: resourceGroup
  name: 'deploy-keyvault'
  params: {
    name: names.keyVault
    location: location
    tags: tags
    enableRbacAuthorization: true
  }
}

// Azure SRE Agent (optional)
module sreAgent 'modules/sre-agent.bicep' = if (deploySreAgent) {
  scope: resourceGroup
  name: 'deploy-sre-agent'
  params: {
    agentName: names.sreAgent
    location: location
    tags: tags
    accessLevel: 'High'
    appInsightsResourceId: appInsights.outputs.appInsightsId
    appInsightsAppId: appInsights.outputs.appId
    appInsightsConnectionString: appInsights.outputs.connectionString
    uniqueSuffix: uniqueSuffix
    apiVersion: sreAgentApiVersion
    enableAzureMonitorIncidents: deployDemoResponsePlan
    // Force the narrowest RG-scope RBAC bundle (Reader + Log Analytics
    // Reader — never Contributor) whenever the demo response plan is
    // active, so the exact-scope AKS remediation role below is a real
    // restriction rather than redundant with a broader Contributor grant.
    // Standard-profile behavior (deployDemoResponsePlan = false) is
    // unaffected — this resolves to false there, exactly as before.
    demoLeastPrivilegeRbac: deployDemoResponsePlan
  }
}

// Least-scope custom RBAC for the demo response plan's exact remediation
// (issue #19) — scoped to only the AKS cluster resource, granting only the
// actions `az aks command invoke` requires. Deployed only when both the SRE
// Agent and the demo response plan are enabled. Combined with sreAgent's
// demoLeastPrivilegeRbac=true above (which withholds RG-scope Contributor in
// this profile), this role is what actually grants write ability for the
// one demo remediation — not an additive/redundant restriction.
module sreAgentDemoRbac 'modules/sre-agent-demo-rbac.bicep' = if (deploySreAgent && deployDemoResponsePlan) {
  scope: resourceGroup
  name: 'deploy-sre-agent-demo-rbac'
  params: {
    aksId: aks.outputs.aksId
    sreAgentPrincipalId: sreAgent!.outputs.managedIdentityPrincipalId
    uniqueSuffix: uniqueSuffix
    workloadName: workloadName
  }
}

// Azure Monitor alert-scanner RBAC (issue #19 round 2) — subscription-scope
// Monitoring Contributor, required per Microsoft's own documentation for the
// SRE Agent's Azure Monitor scanner to discover and manage alert lifecycle
// (see infra/bicep/modules/sre-agent-monitoring-rbac.bicep for citations).
// Deployed ONLY when the demo response plan is enabled AND the operator has
// explicitly acknowledged this unavoidable subscription-scope requirement —
// deployDemoResponsePlan alone is never sufficient to grant this.
module sreAgentMonitoringRbac 'modules/sre-agent-monitoring-rbac.bicep' = if (deploySreAgent && deployDemoResponsePlan && acknowledgeSubscriptionScopeMonitoringRbac) {
  name: 'deploy-sre-agent-monitoring-rbac'
  params: {
    sreAgentPrincipalId: sreAgent!.outputs.managedIdentityPrincipalId
  }
}

// Observability Stack - Managed Grafana and Prometheus (optional)
module observability 'modules/observability.bicep' = if (deployObservability) {
  scope: resourceGroup
  name: 'deploy-observability'
  params: {
    grafanaName: names.grafana
    prometheusName: names.prometheus
    location: location
    tags: tags
    aksClusterId: aks.outputs.aksId
  }
}

// Azure Data Explorer for propane operations log analytics (optional)
module dataExplorer 'modules/data-explorer.bicep' = if (deployDataExplorer) {
  scope: resourceGroup
  name: 'deploy-data-explorer'
  params: {
    clusterName: names.adx
    location: location
    tags: tags
    logAnalyticsWorkspaceId: logAnalytics.outputs.workspaceId
    aksClusterId: aks.outputs.aksId
  }
}

module defaultActionGroup 'modules/action-group.bicep' = if (deployActionGroup) {
  scope: resourceGroup
  name: 'deploy-default-action-group'
  params: {
    name: 'ag-${workloadName}'
    location: location
    tags: tags
    shortName: actionGroupShortName
    webhookServiceUri: incidentWebhookServiceUri
  }
}

var effectiveAlertActionGroupIds = deployActionGroup
  ? concat(alertActionGroupIds, [defaultActionGroup!.outputs.actionGroupId])
  : alertActionGroupIds

module alerts 'modules/alerts.bicep' = if (deployAlerts || deployDemoResponsePlan) {
  scope: resourceGroup
  name: 'deploy-alerts'
  params: {
    namePrefix: 'alert-${workloadName}'
    location: location
    tags: tags
    logAnalyticsWorkspaceId: logAnalytics.outputs.workspaceId
    appNamespace: 'propane'
    actionGroupIds: effectiveAlertActionGroupIds
    deployStandardAlerts: deployAlerts
    deployMongoDbDownDemoAlert: deployDemoResponsePlan
  }
}

// =============================================================================
// OUTPUTS
// =============================================================================

output resourceGroupName string = resourceGroup.name
output aksClusterName string = aks.outputs.aksName
output aksClusterFqdn string = aks.outputs.aksFqdn
output acrLoginServer string = containerRegistry.outputs.loginServer
output logAnalyticsWorkspaceId string = logAnalytics.outputs.workspaceId
output appInsightsId string = appInsights.outputs.appInsightsId
output keyVaultUri string = keyVault.outputs.vaultUri
output grafanaDashboardUrl string = deployObservability ? observability!.outputs.grafanaEndpoint : ''
output azureMonitorWorkspaceId string = deployObservability ? observability!.outputs.azureMonitorWorkspaceId : ''
output prometheusDataCollectionEndpointId string = deployObservability
  ? observability!.outputs.dataCollectionEndpointId
  : ''
output prometheusDataCollectionRuleId string = deployObservability ? observability!.outputs.dataCollectionRuleId : ''
output prometheusDcrAssociationId string = deployObservability
  ? observability!.outputs.dataCollectionRuleAssociationId
  : ''
output defaultActionGroupId string = deployActionGroup ? defaultActionGroup!.outputs.actionGroupId : ''
output defaultActionGroupHasWebhook bool = deployActionGroup ? defaultActionGroup!.outputs.hasWebhookReceiver : false
output podRestartAlertId string = deployAlerts ? alerts!.outputs.podRestartAlertId : ''
output http5xxAlertId string = deployAlerts ? alerts!.outputs.http5xxAlertId : ''
output podFailureAlertId string = deployAlerts ? alerts!.outputs.podFailureAlertId : ''
output crashLoopOomAlertId string = deployAlerts ? alerts!.outputs.crashLoopOomAlertId : ''
output mongoDbDownDemoAlertId string = deployDemoResponsePlan ? alerts!.outputs.mongoDbDownDemoAlertId : ''
output mongoDbDownDemoAlertTitle string = deployDemoResponsePlan ? alerts!.outputs.mongoDbDownDemoAlertTitleUsed : ''
output mongoDbDownDemoAlertSeverity int = deployDemoResponsePlan ? alerts!.outputs.mongoDbDownDemoAlertSeverityUsed : -1
output sreAgentId string = deploySreAgent ? sreAgent!.outputs.agentId : ''
output sreAgentPortalUrl string = deploySreAgent ? sreAgent!.outputs.agentPortalUrl : ''
output sreAgentName string = deploySreAgent ? sreAgent!.outputs.agentName : ''
output sreAgentManagedIdentityId string = deploySreAgent ? sreAgent!.outputs.managedIdentityId : ''
output sreAgentManagedIdentityPrincipalId string = deploySreAgent ? sreAgent!.outputs.managedIdentityPrincipalId : ''
output sreAgentApiVersionUsed string = deploySreAgent ? sreAgent!.outputs.apiVersionUsed : ''
output sreAgentManagedResourceGroupId string = deploySreAgent ? sreAgent!.outputs.managedResourceGroupId : ''
output sreAgentAppInsightsResourceId string = deploySreAgent ? sreAgent!.outputs.appInsightsResourceIdBound : ''
output sreAgentAccessLevel string = deploySreAgent ? sreAgent!.outputs.accessLevel : ''
output sreAgentAssignedRoleDefinitionIds array = deploySreAgent ? sreAgent!.outputs.assignedRoleDefinitionIds : []
output sreAgentIncidentManagementConfigured bool = deploySreAgent ? sreAgent!.outputs.incidentManagementConfigured : false
output sreAgentDemoLeastPrivilegeRbacApplied bool = deploySreAgent ? sreAgent!.outputs.demoLeastPrivilegeRbacApplied : false
output sreAgentDemoRbacRoleDefinitionId string = (deploySreAgent && deployDemoResponsePlan) ? sreAgentDemoRbac!.outputs.roleDefinitionId : ''
output sreAgentDemoRbacScopedActions array = (deploySreAgent && deployDemoResponsePlan) ? sreAgentDemoRbac!.outputs.scopedActions : []
output sreAgentMonitoringRbacRoleAssignmentId string = (deploySreAgent && deployDemoResponsePlan && acknowledgeSubscriptionScopeMonitoringRbac) ? sreAgentMonitoringRbac!.outputs.roleAssignmentId : ''
output adxClusterUri string = deployDataExplorer ? dataExplorer!.outputs.clusterUri : ''
output adxDatabaseName string = deployDataExplorer ? dataExplorer!.outputs.databaseName : ''
