# =============================================================================
# Container Registry Module
# =============================================================================
# Hosts container images for the demo application services.
# =============================================================================

resource "azurerm_container_registry" "main" {
  name                          = var.name
  location                      = var.location
  resource_group_name           = var.resource_group_name
  tags                          = var.tags
  sku                           = var.sku
  admin_enabled                 = var.admin_user_enabled
  public_network_access_enabled = true
}
