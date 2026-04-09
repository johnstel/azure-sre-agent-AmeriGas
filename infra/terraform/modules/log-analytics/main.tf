# =============================================================================
# Log Analytics Module
# =============================================================================
# Provides centralized logging for AKS, application telemetry, and SRE Agent
# diagnostics. This is a prerequisite for Azure SRE Agent.
# =============================================================================

resource "azurerm_log_analytics_workspace" "main" {
  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = var.tags
  sku                 = var.sku
  retention_in_days   = var.retention_in_days
  daily_quota_gb      = -1 # Unlimited

  allow_resource_only_permissions = true
}

# Container Insights solution for AKS monitoring
resource "azurerm_log_analytics_solution" "container_insights" {
  solution_name         = "ContainerInsights"
  location              = var.location
  resource_group_name   = var.resource_group_name
  workspace_resource_id = azurerm_log_analytics_workspace.main.id
  workspace_name        = azurerm_log_analytics_workspace.main.name
  tags                  = var.tags

  plan {
    publisher = "Microsoft"
    product   = "OMSGallery/ContainerInsights"
  }
}
