# =============================================================================
# Key Vault Module
# =============================================================================
# Provides secure secrets management. SRE Agent can help diagnose
# Key Vault access issues and configuration problems.
# =============================================================================

resource "azurerm_key_vault" "main" {
  name                          = var.name
  location                      = var.location
  resource_group_name           = var.resource_group_name
  tags                          = var.tags
  tenant_id                     = var.tenant_id
  sku_name                      = var.sku_name
  enable_rbac_authorization     = var.enable_rbac_authorization
  soft_delete_retention_days    = 7
  purge_protection_enabled      = false
  public_network_access_enabled = true

  network_acls {
    bypass         = "AzureServices"
    default_action = "Allow"
  }
}
