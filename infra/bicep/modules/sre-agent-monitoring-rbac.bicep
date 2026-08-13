// =============================================================================
// SRE Agent Azure Monitor Scanner RBAC Module (issue #19, round 2)
// =============================================================================
// Grants the built-in Monitoring Contributor role
// (749f88d5-cbae-40b8-bcfc-e573ddc772fa) to the SRE Agent's managed identity
// at SUBSCRIPTION scope.
//
// This is NOT a design choice made by this repository — it is the minimum
// scope Microsoft's own documentation requires for the Azure Monitor alert
// scanner to function:
//
//   "If alerts don't appear after you connect Azure Monitor, verify the
//    following conditions: 1. The agent's managed identity has the
//    Monitoring Contributor role on the subscription."
//   — https://learn.microsoft.com/azure/sre-agent/azure-monitor-alerts
//
//   "Preconfigured roles (always assigned) ... Monitoring Contributor |
//    Subscription | Acknowledge and close Azure Monitor alerts and update
//    monitoring settings ... Assign the Monitoring Contributor role at the
//    subscription level during agent creation so your agent can manage the
//    Azure Monitor alert lifecycle (acknowledge, close) out of the box."
//   — https://learn.microsoft.com/azure/sre-agent/agent-permissions
//
// Monitoring Contributor does NOT grant Contributor over arbitrary
// resources (it cannot modify non-monitoring resources — see
// https://learn.microsoft.com/azure/role-based-access-control/built-in-roles#monitor)
// but it IS subscription-scoped by design of the built-in role itself; there
// is no resource-group-scoped equivalent that lets the platform's Azure
// Monitor alert scanner discover and manage alert lifecycle across the
// subscription. This module exists so that unavoidable scope requirement is
// isolated to its own file, deployed ONLY for the demo response-plan
// profile, and requires an explicit operator acknowledgement parameter
// (main.bicep's `acknowledgeSubscriptionScopeMonitoringRbac`) rather than
// being silently bundled into the existing resource-group-scope RBAC.
// =============================================================================

targetScope = 'subscription'

@description('Object (principal) ID of the SRE Agent managed identity to receive Monitoring Contributor at subscription scope.')
param sreAgentPrincipalId string

// Verified via `az role definition list --name "Monitoring Contributor"` on 2026-08-12.
var monitoringContributorRoleId = '749f88d5-cbae-40b8-bcfc-e573ddc772fa'

resource monitoringContributorAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(subscription().id, sreAgentPrincipalId, monitoringContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', monitoringContributorRoleId)
    principalId: sreAgentPrincipalId
    principalType: 'ServicePrincipal'
  }
}

output roleAssignmentId string = monitoringContributorAssignment.id
output roleDefinitionId string = monitoringContributorAssignment.properties.roleDefinitionId
output principalId string = sreAgentPrincipalId
