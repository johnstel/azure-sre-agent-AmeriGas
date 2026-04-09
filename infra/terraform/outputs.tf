# =============================================================================
# Azure SRE Agent Energy Grid Demo Lab - Root Outputs
# =============================================================================

output "resource_group_name" {
  description = "Name of the resource group"
  value       = azurerm_resource_group.main.name
}

output "aks_cluster_name" {
  description = "Name of the AKS cluster"
  value       = module.aks.aks_name
}

output "aks_cluster_fqdn" {
  description = "FQDN of the AKS cluster"
  value       = module.aks.aks_fqdn
}

output "acr_login_server" {
  description = "ACR login server URL"
  value       = module.container_registry.login_server
}

output "log_analytics_workspace_id" {
  description = "Log Analytics workspace resource ID"
  value       = module.log_analytics.workspace_id
}

output "app_insights_id" {
  description = "Application Insights resource ID"
  value       = module.app_insights.app_insights_id
}

output "app_insights_connection_string" {
  description = "Application Insights connection string"
  value       = module.app_insights.connection_string
  sensitive   = true
}

output "key_vault_uri" {
  description = "Key Vault URI"
  value       = module.key_vault.vault_uri
}

output "grafana_dashboard_url" {
  description = "Managed Grafana dashboard URL"
  value       = var.deploy_observability ? module.observability[0].grafana_endpoint : ""
}

output "azure_monitor_workspace_id" {
  description = "Azure Monitor workspace resource ID"
  value       = var.deploy_observability ? module.observability[0].azure_monitor_workspace_id : ""
}

output "prometheus_data_collection_rule_id" {
  description = "Prometheus data collection rule resource ID"
  value       = var.deploy_observability ? module.observability[0].data_collection_rule_id : ""
}

output "default_action_group_id" {
  description = "Default action group resource ID"
  value       = var.deploy_action_group ? module.action_group[0].action_group_id : ""
}

output "default_action_group_has_webhook" {
  description = "Whether the default action group has a webhook receiver"
  value       = var.deploy_action_group ? module.action_group[0].has_webhook_receiver : false
}

output "pod_restart_alert_id" {
  description = "Pod restart alert resource ID"
  value       = var.deploy_alerts ? module.alerts[0].pod_restart_alert_id : ""
}

output "http_5xx_alert_id" {
  description = "HTTP 5xx alert resource ID"
  value       = var.deploy_alerts ? module.alerts[0].http_5xx_alert_id : ""
}

output "pod_failure_alert_id" {
  description = "Pod failure alert resource ID"
  value       = var.deploy_alerts ? module.alerts[0].pod_failure_alert_id : ""
}

output "crash_loop_oom_alert_id" {
  description = "CrashLoop/OOM alert resource ID"
  value       = var.deploy_alerts ? module.alerts[0].crash_loop_oom_alert_id : ""
}

output "sre_agent_id" {
  description = "SRE Agent resource ID"
  value       = var.deploy_sre_agent ? module.sre_agent[0].agent_id : ""
}

output "sre_agent_portal_url" {
  description = "SRE Agent portal URL"
  value       = var.deploy_sre_agent ? module.sre_agent[0].agent_portal_url : ""
}

output "sre_agent_name" {
  description = "SRE Agent name"
  value       = var.deploy_sre_agent ? module.sre_agent[0].agent_name : ""
}

output "sre_agent_managed_identity_id" {
  description = "SRE Agent managed identity resource ID"
  value       = var.deploy_sre_agent ? module.sre_agent[0].managed_identity_id : ""
}

output "sre_agent_managed_identity_principal_id" {
  description = "SRE Agent managed identity principal ID"
  value       = var.deploy_sre_agent ? module.sre_agent[0].managed_identity_principal_id : ""
}
