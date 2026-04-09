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
