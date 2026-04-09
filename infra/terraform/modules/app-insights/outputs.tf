# =============================================================================
# Application Insights Module - Outputs
# =============================================================================

output "app_insights_id" {
  description = "Application Insights resource ID"
  value       = azurerm_application_insights.main.id
}

output "app_insights_name" {
  description = "Application Insights name"
  value       = azurerm_application_insights.main.name
}

output "app_id" {
  description = "Application Insights App ID"
  value       = azurerm_application_insights.main.app_id
}

output "instrumentation_key" {
  description = "Application Insights instrumentation key"
  value       = azurerm_application_insights.main.instrumentation_key
  sensitive   = true
}

output "connection_string" {
  description = "Application Insights connection string"
  value       = azurerm_application_insights.main.connection_string
  sensitive   = true
}
