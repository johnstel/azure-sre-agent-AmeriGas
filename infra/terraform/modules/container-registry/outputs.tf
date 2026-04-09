# =============================================================================
# Container Registry Module - Outputs
# =============================================================================

output "acr_id" {
  description = "Container Registry resource ID"
  value       = azurerm_container_registry.main.id
}

output "acr_name" {
  description = "Container Registry name"
  value       = azurerm_container_registry.main.name
}

output "login_server" {
  description = "Container Registry login server URL"
  value       = azurerm_container_registry.main.login_server
}
