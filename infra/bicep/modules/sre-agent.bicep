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

@description('The access level for the SRE Agent (High = Reader + Contributor + Log Analytics Contributor for approved remediation, Low = Reader + Log Analytics Reader — read-only, no remediation)')
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

@description('Declaratively connect Azure Monitor as the incident management platform (properties.incidentManagementConfiguration.type = AzMonitor), per the documented AgentProperties schema (issue #19). Off by default; the demo profile turns this on. Per Microsoft docs, Azure Monitor also auto-connects on agent creation regardless of this flag — this makes the intent explicit and idempotent in source control rather than relying on that implicit behavior.')
param enableAzureMonitorIncidents bool = false

@description('When true, restricts the resource-group-scope RBAC granted to the SRE Agent managed identity to Reader + Log Analytics Reader ONLY — regardless of accessLevel. Used exclusively by the demo response-plan profile (issue #19 round 2) so the agent does NOT receive resource-group-scope Contributor, which would make the least-scope AKS custom remediation role (sre-agent-demo-rbac.bicep) redundant as an actual restriction. This does NOT change actionConfiguration.accessLevel (the platform-level flag controlling whether the agent may propose/execute write actions at all, per https://learn.microsoft.com/azure/sre-agent/agent-permissions) — that stays whatever accessLevel resolves to. Actual write ability remains bounded strictly by whichever RBAC is granted: the narrow RG-scope roles here, plus any additional resource-scoped roles (e.g. the AKS remediation role) granted separately. Off by default; standard-profile behavior (accessLevel-driven roleDefinitions bundle) is completely unchanged when this is false.')
param demoLeastPrivilegeRbac bool = false

// =============================================================================
// VARIABLES
// =============================================================================

var identityName = '${agentName}-${uniqueSuffix}'

// The exact deployed lab resource group ID — this is the sole entry in
// knowledgeGraphConfiguration.managedResources so the agent's knowledge
// graph can never drift to a different resource group or subscription.
var managedResourceGroupId = resourceGroup().id

// Built-in Azure RBAC role definition GUIDs, named explicitly so the
// GUID-to-role mapping is verifiable from the compiled ARM template (not
// just from a comment) and can't silently drift out of sync with its label.
// Verified against `az role definition list` on 2026-08-12:
//   az role definition list --query "[?name=='<guid>'].{name:roleName}"
var roleDefinitionIds = {
  logAnalyticsReader: '73c42c96-874c-492b-b04d-ab87d138a893' // Log Analytics Reader — read-only query access
  logAnalyticsContributor: '92aaf0da-9dab-42b6-94a3-d43ce8d16293' // Log Analytics Contributor — manage saved searches/alerts, required for approved remediation
  reader: 'acdd72a7-3385-48ef-bd42-f606fba81ae7' // Reader
  contributor: 'b24988ac-6180-42a0-ab88-20f7382dd24c' // Contributor
}

// Role definition IDs by access level. All assignments are scoped to this
// resource group only (least-scope RBAC) — never subscription-wide.
// Low is strictly read-only (diagnosis only, no remediation). High adds
// Contributor (full remediation) and Log Analytics Contributor
// (manage/act on Log Analytics saved searches and alerts as part of
// approved remediation actions) — deliberately, not a mislabeled Reader.
var roleDefinitions = {
  Low: [
    roleDefinitionIds.logAnalyticsReader
    roleDefinitionIds.reader
  ]
  High: [
    roleDefinitionIds.logAnalyticsContributor
    roleDefinitionIds.reader
    roleDefinitionIds.contributor
  ]
}

// The demo response-plan profile (issue #19 round 2) forces the narrowest
// possible RG-scope bundle (Reader + Log Analytics Reader — the same set as
// Low) regardless of accessLevel, so the SRE identity never receives
// resource-group-scope Contributor. Its actual remediation write ability for
// the one demo scenario comes exclusively from the separately-granted,
// AKS-cluster-scoped custom role (sre-agent-demo-rbac.bicep), which is a
// real restriction only when this RG-scope bundle excludes Contributor.
// Standard-profile behavior (demoLeastPrivilegeRbac = false) is completely
// unchanged: it still resolves to roleDefinitions[accessLevel] exactly as
// before.
var effectiveRoleDefinitions = demoLeastPrivilegeRbac
  ? [
      roleDefinitionIds.reader
      roleDefinitionIds.logAnalyticsReader
    ]
  : roleDefinitions[accessLevel]

var agentIdentityConfig = {
  type: 'SystemAssigned, UserAssigned'
  userAssignedIdentities: {
    '${managedIdentity.id}': {}
  }
}

// incidentManagementConfiguration.type is a documented AgentProperties field
// (Microsoft.App/agents ARM template reference: 'PagerDuty' | 'AzMonitor' |
// 'ServiceNow' | 'None'). Kept as a plain object (rather than swapping the
// entire agentProperties object via union/conditional) so every other key —
// knowledgeGraphConfiguration, actionConfiguration, logConfiguration — stays
// a directly-resolvable literal in the compiled template regardless of this
// parameter's value; only the incidentManagementConfiguration property
// itself is conditional.
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
  incidentManagementConfiguration: enableAzureMonitorIncidents
    ? {
        type: 'AzMonitor'
      }
    : null
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
resource roleAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (roleId, index) in effectiveRoleDefinitions: {
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
output accessLevel string = accessLevel
output assignedRoleDefinitionIds array = effectiveRoleDefinitions
output incidentManagementConfigured bool = enableAzureMonitorIncidents
output demoLeastPrivilegeRbacApplied bool = demoLeastPrivilegeRbac
