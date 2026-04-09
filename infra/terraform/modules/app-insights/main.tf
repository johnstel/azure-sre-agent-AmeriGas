# =============================================================================
# Application Insights Module
# =============================================================================
# Provides application-level telemetry for the demo application. SRE Agent
# can analyze Application Insights data for troubleshooting.
# =============================================================================

resource "azurerm_application_insights" "main" {
  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = var.tags
  workspace_id        = var.workspace_id
  application_type    = var.application_type
  retention_in_days   = 90
  disable_ip_masking  = false
}
