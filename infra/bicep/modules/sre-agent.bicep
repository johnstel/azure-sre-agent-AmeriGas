// =============================================================================
// Azure SRE Agent Module
// =============================================================================
// Deploys an Azure SRE Agent with managed identity and role assignments.
// Based on: https://github.com/microsoft/sre-agent/tree/main/samples/bicep-deployment
// Resource type: Microsoft.App/agents
//
// API version pinning: deploy.ps1 queries the target subscription's
// Microsoft.App resource-provider metadata (`az provider show`) and selects
// the newest apiVersion this module supports (2026-01-01 GA, falling back to
// 2025-05-01-preview) before invoking this deployment. See
// docs/SRE-AGENT-SETUP.md for the detection/failure behavior — the deploy
// script fails clearly rather than silently degrading when neither version
// is registered for the subscription.
// =============================================================================

@description('Name of the SRE Agent')
param agentName string

@description('Azure region for deployment')
param location string

@description('Tags to apply to resources')
param tags object

@description('The access level for the SRE Agent (High = Reader + Contributor + Log Analytics Reader, Low = Reader + Log Analytics Reader)')
@allowed(['High', 'Low'])
param accessLevel string = 'High'

@description('Application Insights resource ID (bound for telemetry consistency validation)')
param appInsightsResourceId string

@description('Application Insights App ID')
param appInsightsAppId string

@secure()
@description('Application Insights connection string')
param appInsightsConnectionString string

@description('Unique suffix for resource naming')
param uniqueSuffix string

@description('Pinned Microsoft.App/agents control-plane API version. Must be validated as supported by the target subscription before this module is deployed.')
@allowed([
  '2026-01-01'
  '2025-05-01-preview'
])
param apiVersion string = '2026-01-01'

// =============================================================================
// VARIABLES
// =============================================================================

var identityName = '${agentName}-${uniqueSuffix}'

// The exact deployed lab resource group ID — this is the sole entry in
// knowledgeGraphConfiguration.managedResources so the agent's knowledge
// graph can never drift to a different resource group or subscription.
var managedResourceGroupId = resourceGroup().id

// Role definition IDs by access level. All assignments are scoped to this
// resource group only (least-scope RBAC) — never subscription-wide.
var roleDefinitions = {
  Low: [
    '92aaf0da-9dab-42b6-94a3-d43ce8d16293' // Log Analytics Reader
    'acdd72a7-3385-48ef-bd42-f606fba81ae7' // Reader
  ]
  High: [
    '92aaf0da-9dab-42b6-94a3-d43ce8d16293' // Log Analytics Reader
    'acdd72a7-3385-48ef-bd42-f606fba81ae7' // Reader
    'b24988ac-6180-42a0-ab88-20f7382dd24c' // Contributor
  ]
}

var agentIdentityConfig = {
  type: 'SystemAssigned, UserAssigned'
  userAssignedIdentities: {
    '${managedIdentity.id}': {}
  }
}

var agentProperties = {
  knowledgeGraphConfiguration: {
    identity: managedIdentity.id
    managedResources: [
      managedResourceGroupId
    ]
  }
  actionConfiguration: {
    accessLevel: accessLevel
    identity: managedIdentity.id
    mode: 'Review'
  }
  logConfiguration: {
    applicationInsightsConfiguration: {
      appId: appInsightsAppId
      connectionString: appInsightsConnectionString
    }
  }
}

// =============================================================================
// RESOURCES
// =============================================================================

// User-Assigned Managed Identity for SRE Agent
#disable-next-line BCP073
resource managedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: identityName
  location: location
  tags: tags
  properties: {
    isolationScope: 'Regional'
  }
}

// Role assignments for the managed identity, scoped to this resource group only
resource roleAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (roleId, index) in roleDefinitions[accessLevel]: {
  name: guid(resourceGroup().id, managedIdentity.id, roleId)
  properties: {
    roleDefinitionId: resourceId('Microsoft.Authorization/roleDefinitions', roleId)
    principalId: managedIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}]

// SRE Agent — GA API version (2026-01-01), deployed when the target
// subscription's Microsoft.App provider registers it.
resource sreAgentV2026 'Microsoft.App/agents@2026-01-01' = if (apiVersion == '2026-01-01') {
  name: agentName
  location: location
  tags: tags
  identity: agentIdentityConfig
  properties: agentProperties
  dependsOn: [
    roleAssignments
  ]
}

// SRE Agent — Preview API version (2025-05-01-preview) fallback for
// subscriptions that have not yet been rolled onto the GA API version.
#disable-next-line BCP081
resource sreAgentV2025Preview 'Microsoft.App/agents@2025-05-01-preview' = if (apiVersion == '2025-05-01-preview') {
  name: agentName
  location: location
  tags: tags
  identity: agentIdentityConfig
  properties: agentProperties
  dependsOn: [
    roleAssignments
  ]
}

var deployedAgentId = apiVersion == '2026-01-01' ? sreAgentV2026!.id : sreAgentV2025Preview!.id
var deployedAgentName = apiVersion == '2026-01-01' ? sreAgentV2026!.name : sreAgentV2025Preview!.name

// Assign SRE Agent Administrator role to the deployer
// This allows the deploying user to manage the agent in the portal.
// Resource `scope` must be resolvable at compile time, so the assignment is
// declared once per conditional agent resource rather than via a ternary.
resource sreAgentAdminRoleAssignmentV2026 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (apiVersion == '2026-01-01') {
  name: guid(sreAgentV2026.id, deployer().objectId, 'e79298df-d852-4c6d-84f9-5d13249d1e55')
  scope: sreAgentV2026
  properties: {
    roleDefinitionId: resourceId('Microsoft.Authorization/roleDefinitions', 'e79298df-d852-4c6d-84f9-5d13249d1e55') // SRE Agent Administrator
    principalId: deployer().objectId
    principalType: 'User'
  }
}

resource sreAgentAdminRoleAssignmentV2025Preview 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (apiVersion == '2025-05-01-preview') {
  name: guid(sreAgentV2025Preview.id, deployer().objectId, 'e79298df-d852-4c6d-84f9-5d13249d1e55')
  scope: sreAgentV2025Preview
  properties: {
    roleDefinitionId: resourceId('Microsoft.Authorization/roleDefinitions', 'e79298df-d852-4c6d-84f9-5d13249d1e55') // SRE Agent Administrator
    principalId: deployer().objectId
    principalType: 'User'
  }
}

// =============================================================================
// OUTPUTS
// =============================================================================

output agentName string = deployedAgentName
output agentId string = deployedAgentId
output agentPortalUrl string = 'https://portal.azure.com/#view/Microsoft_Azure_PaasServerless/AgentFrameBlade.ReactView/id/${replace(deployedAgentId, '/', '%2F')}'
output managedIdentityId string = managedIdentity.id
output managedIdentityPrincipalId string = managedIdentity.properties.principalId
output apiVersionUsed string = apiVersion
output managedResourceGroupId string = managedResourceGroupId
output appInsightsResourceIdBound string = appInsightsResourceId
