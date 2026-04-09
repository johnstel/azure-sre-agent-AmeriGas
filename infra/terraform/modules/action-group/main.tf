# =============================================================================
# Action Group Module
# =============================================================================
# Deploys a default Azure Monitor Action Group for incident routing.
# Supports webhook/Logic App callback URL integration.
# =============================================================================

resource "azurerm_monitor_action_group" "main" {
  name                = var.name
  resource_group_name = var.resource_group_name
  tags                = var.tags
  short_name          = var.short_name
  enabled             = true

  dynamic "webhook_receiver" {
    for_each = var.webhook_service_uri != "" ? [1] : []
    content {
      name                    = "incident-webhook"
      service_uri             = var.webhook_service_uri
      use_common_alert_schema = true
    }
  }
}
