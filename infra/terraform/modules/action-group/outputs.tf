# =============================================================================
# Action Group Module - Outputs
# =============================================================================

output "action_group_id" {
  description = "Action Group resource ID"
  value       = azurerm_monitor_action_group.main.id
}

output "has_webhook_receiver" {
  description = "Whether the action group has a webhook receiver configured"
  value       = var.webhook_service_uri != ""
}
