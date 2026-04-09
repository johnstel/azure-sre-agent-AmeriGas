# =============================================================================
# Observability Module - Outputs
# =============================================================================

output "grafana_id" {
  description = "Managed Grafana resource ID"
  value       = azurerm_dashboard_grafana.main.id
}

output "grafana_name" {
  description = "Managed Grafana name"
  value       = azurerm_dashboard_grafana.main.name
}

output "grafana_endpoint" {
  description = "Managed Grafana endpoint URL"
  value       = azurerm_dashboard_grafana.main.endpoint
}

output "azure_monitor_workspace_id" {
  description = "Azure Monitor workspace resource ID"
  value       = azurerm_monitor_workspace.main.id
}

output "data_collection_endpoint_id" {
  description = "Prometheus data collection endpoint resource ID"
  value       = azurerm_monitor_data_collection_endpoint.prometheus.id
}

output "data_collection_rule_id" {
  description = "Prometheus data collection rule resource ID"
  value       = azurerm_monitor_data_collection_rule.prometheus.id
}

output "data_collection_endpoint_association_id" {
  description = "Prometheus DCE association ID"
  value       = azurerm_monitor_data_collection_rule_association.prometheus_dce.id
}

output "data_collection_rule_association_id" {
  description = "Prometheus DCR association ID"
  value       = azurerm_monitor_data_collection_rule_association.prometheus_dcr.id
}
