# =============================================================================
# Alerts Module - Outputs
# =============================================================================

output "pod_restart_alert_id" {
  description = "Pod restart alert resource ID"
  value       = azurerm_monitor_scheduled_query_rules_alert_v2.pod_restarts.id
}

output "http_5xx_alert_id" {
  description = "HTTP 5xx alert resource ID"
  value       = azurerm_monitor_scheduled_query_rules_alert_v2.http_5xx.id
}

output "pod_failure_alert_id" {
  description = "Pod failure alert resource ID"
  value       = azurerm_monitor_scheduled_query_rules_alert_v2.pod_failures.id
}

output "crash_loop_oom_alert_id" {
  description = "CrashLoop/OOM alert resource ID"
  value       = azurerm_monitor_scheduled_query_rules_alert_v2.crash_loop_oom.id
}
