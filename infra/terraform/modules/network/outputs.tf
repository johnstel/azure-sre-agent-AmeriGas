# =============================================================================
# Network Module - Outputs
# =============================================================================

output "vnet_id" {
  description = "Virtual network resource ID"
  value       = azurerm_virtual_network.main.id
}

output "vnet_name" {
  description = "Virtual network name"
  value       = azurerm_virtual_network.main.name
}

output "aks_subnet_id" {
  description = "AKS subnet resource ID"
  value       = azurerm_subnet.aks.id
}

output "services_subnet_id" {
  description = "Services subnet resource ID"
  value       = azurerm_subnet.services.id
}
