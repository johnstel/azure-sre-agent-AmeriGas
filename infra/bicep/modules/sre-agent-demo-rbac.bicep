// =============================================================================
// SRE Agent Demo Response-Plan RBAC Module (issue #19)
// =============================================================================
// This module grants a purpose-built custom role, scoped to the AKS cluster
// resource only (never the resource group or subscription), containing
// exactly the actions Microsoft documents as required for
// `az aks command invoke` plus read:
//   - Microsoft.ContainerService/managedClusters/read
//   - Microsoft.ContainerService/managedClusters/runCommand/action
//   - Microsoft.ContainerService/managedClusters/commandResults/read
//
// In the demo profile, infra/bicep/modules/sre-agent.bicep's
// demoLeastPrivilegeRbac withholds resource-group Contributor from the SRE
// identity (it is granted only Reader + Log Analytics Reader there instead
// of the standard High bundle's Contributor + Log Analytics Contributor).
// That makes this module's AKS-cluster-scoped role the SOLE direct write
// permission behind the one remediation this response plan proposes — not
// an additive convenience on top of a broader Contributor grant. The
// standard profile (demoLeastPrivilegeRbac = false) still grants the wider
// resource-group High bundle for general-purpose diagnosis/remediation
// across the whole lab, independent of whether this module is deployed.
//
// Deliberately NOT included (out of scope for this exact remediation, and
// consistent with the platform's own delete/remove and Key Vault guardrails
// documented in https://learn.microsoft.com/azure/sre-agent/execute-mitigations):
//   - Microsoft.ContainerService/managedClusters/write (would allow modifying
//     the cluster itself, e.g. node pools/version/network — not needed to
//     scale a workload inside it via command invoke)
//   - Microsoft.ContainerService/managedClusters/listClusterUserCredential/action
//     or listClusterAdminCredential/action (would allow pulling kubeconfig
//     directly, bypassing command invoke's audited execution path)
//   - Any Microsoft.ContainerService/managedClusters/delete
// =============================================================================

@description('Resource ID of the AKS cluster this custom role is scoped to. The role is assignable ONLY at this exact resource — never resource-group or subscription scope.')
param aksId string

@description('Object (principal) ID of the SRE Agent managed identity to receive this role assignment.')
param sreAgentPrincipalId string

@description('Suffix used to keep the custom role definition name/GUID deterministic and idempotent across reruns for this workload.')
param uniqueSuffix string

@description('Workload name, used only to namespace the custom role\'s display name.')
param workloadName string

// Deterministic role definition ID (idempotent: same inputs -> same GUID on
// every deployment, so reruns update the existing definition rather than
// creating a duplicate).
var roleDefinitionGuid = guid(aksId, 'sre-agent-mongodb-remediation-role', uniqueSuffix)

// Existing reference to the AKS cluster so the role assignment below can be
// scoped to the exact cluster resource (not the resource group it lives in).
resource aksCluster 'Microsoft.ContainerService/managedClusters@2024-02-01' existing = {
  name: last(split(aksId, '/'))
}

resource mongoDbRemediationRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: roleDefinitionGuid
  properties: {
    roleName: 'ZavaGas SRE Agent - MongoDB Remediation (${workloadName})'
    description: 'Least-scope custom role for the issue #19 MongoDB-down demo response plan: grants exactly the actions Microsoft documents as required for `az aks command invoke` (runCommand, commandResults/read) plus read, scoped to this one AKS cluster resource only. Does not grant cluster write, credential listing, or delete.'
    type: 'CustomRole'
    permissions: [
      {
        actions: [
          'Microsoft.ContainerService/managedClusters/read'
          'Microsoft.ContainerService/managedClusters/runCommand/action'
          'Microsoft.ContainerService/managedClusters/commandResults/read'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
    // Assignable ONLY at this exact AKS resource — never the resource group
    // or subscription. scripts/validate-deployment.ps1 fails if it finds
    // this role (or the assignment below) at any broader scope.
    assignableScopes: [
      aksId
    ]
  }
}

resource mongoDbRemediationAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(aksId, sreAgentPrincipalId, roleDefinitionGuid)
  scope: aksCluster
  properties: {
    roleDefinitionId: mongoDbRemediationRole.id
    principalId: sreAgentPrincipalId
    principalType: 'ServicePrincipal'
  }
}

output roleDefinitionId string = mongoDbRemediationRole.id
output roleAssignmentId string = mongoDbRemediationAssignment.id
output scopedActions array = mongoDbRemediationRole.properties.permissions[0].actions
