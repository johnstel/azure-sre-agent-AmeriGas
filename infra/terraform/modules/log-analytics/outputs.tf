# =============================================================================
# Log Analytics Module - Outputs
# =============================================================================

output "workspace_id" {
  description = "Log Analytics workspace resource ID"
  value       = azurerm_log_analytics_workspace.main.id
}

output "workspace_name" {
  description = "Log Analytics workspace name"
  value       = azurerm_log_analytics_workspace.main.name
}

output "customer_id" {
  description = "Log Analytics workspace customer ID (GUID)"
  value       = azurerm_log_analytics_workspace.main.workspace_id
}
