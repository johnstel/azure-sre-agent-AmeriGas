# =============================================================================
# SRE Agent Module - Outputs
# =============================================================================

output "agent_name" {
  description = "SRE Agent name"
  value       = azapi_resource.sre_agent.name
}

output "agent_id" {
  description = "SRE Agent resource ID"
  value       = azapi_resource.sre_agent.id
}

output "agent_portal_url" {
  description = "SRE Agent portal URL"
  value       = "https://portal.azure.com/#view/Microsoft_Azure_PaasServerless/AgentFrameBlade.ReactView/id/${replace(azapi_resource.sre_agent.id, "/", "%2F")}"
}

output "managed_identity_id" {
  description = "SRE Agent managed identity resource ID"
  value       = azurerm_user_assigned_identity.sre_agent.id
}

output "managed_identity_principal_id" {
  description = "SRE Agent managed identity principal ID"
  value       = azurerm_user_assigned_identity.sre_agent.principal_id
}

output "access_level" {
  description = "The access level (Low/High) the SRE Agent's role assignments were derived from"
  value       = var.access_level
}

output "assigned_role_definition_ids" {
  description = "The exact built-in role definition GUIDs assigned to the SRE Agent identity for the selected access level"
  value       = local.selected_roles
}

output "managed_resource_group_id" {
  description = "The exact resource group ID bound in knowledgeGraphConfiguration.managedResources"
  value       = data.azurerm_resource_group.main.id
}
