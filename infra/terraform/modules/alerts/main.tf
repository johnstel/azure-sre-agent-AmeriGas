# =============================================================================
# Alerts Module
# =============================================================================
# Deploys baseline Azure Monitor scheduled query alerts for the Energy Grid
# platform. These alerts can be connected to action groups for paging/incident
# workflows.
# =============================================================================

locals {
  action_groups = [for id in var.action_group_ids : {
    action_group_id = id
  }]
}

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "pod_restarts" {
  name                = "${var.name_prefix}-pod-restarts"
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = var.tags

  display_name          = "Energy Grid - Pod restart spike"
  description           = "Triggers quickly when restart activity is detected in the energy grid namespace."
  enabled               = true
  severity              = 2
  scopes                = [var.log_analytics_workspace_id]
  evaluation_frequency  = "PT1M"
  window_duration       = "PT1M"
  auto_mitigation_enabled = true
  skip_query_validation = true

  criteria {
    query = "KubePodInventory | where TimeGenerated > ago(2m) | where Namespace == \"${var.app_namespace}\" | where ContainerRestartCount > 0"

    time_aggregation_method = "Count"
    operator                = "GreaterThan"
    threshold               = 0

    failing_periods {
      number_of_evaluation_periods = 1
      minimum_failing_periods_to_trigger_alert = 1
    }
  }

  action {
    action_groups     = var.action_group_ids
    custom_properties = {
      source   = "azure-sre-agent-sandbox"
      workload = "energy-grid"
    }
  }
}

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "http_5xx" {
  name                = "${var.name_prefix}-http-5xx"
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = var.tags

  display_name          = "Energy Grid - HTTP 5xx spike"
  description           = "Triggers when 5xx request count increases in energy grid App Insights logs."
  enabled               = true
  severity              = 1
  scopes                = [var.log_analytics_workspace_id]
  evaluation_frequency  = "PT5M"
  window_duration       = "PT10M"
  auto_mitigation_enabled = true
  skip_query_validation = true

  criteria {
    query = "AppRequests | where TimeGenerated > ago(10m) | where toint(ResultCode) >= 500"

    time_aggregation_method = "Count"
    operator                = "GreaterThan"
    threshold               = 20

    failing_periods {
      number_of_evaluation_periods = 1
      minimum_failing_periods_to_trigger_alert = 1
    }
  }

  action {
    action_groups     = var.action_group_ids
    custom_properties = {
      source   = "azure-sre-agent-sandbox"
      workload = "energy-grid"
    }
  }
}

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "pod_failures" {
  name                = "${var.name_prefix}-pod-failures"
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = var.tags

  display_name          = "Energy Grid - Failed or pending pods"
  description           = "Triggers quickly when failed or pending pods are detected in the energy grid namespace."
  enabled               = true
  severity              = 2
  scopes                = [var.log_analytics_workspace_id]
  evaluation_frequency  = "PT1M"
  window_duration       = "PT1M"
  auto_mitigation_enabled = true
  skip_query_validation = true

  criteria {
    query = "KubePodInventory | where TimeGenerated > ago(2m) | where Namespace == \"${var.app_namespace}\" | where PodStatus in (\"Failed\", \"Pending\")"

    time_aggregation_method = "Count"
    operator                = "GreaterThan"
    threshold               = 0

    failing_periods {
      number_of_evaluation_periods = 1
      minimum_failing_periods_to_trigger_alert = 1
    }
  }

  action {
    action_groups     = var.action_group_ids
    custom_properties = {
      source   = "azure-sre-agent-sandbox"
      workload = "energy-grid"
    }
  }
}

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "crash_loop_oom" {
  name                = "${var.name_prefix}-crashloop-oom"
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = var.tags

  display_name          = "Energy Grid - CrashLoop/OOM detected"
  description           = "Triggers when CrashLoopBackOff or OOM-related Kubernetes events are detected in the energy grid namespace."
  enabled               = true
  severity              = 1
  scopes                = [var.log_analytics_workspace_id]
  evaluation_frequency  = "PT1M"
  window_duration       = "PT1M"
  auto_mitigation_enabled = true
  skip_query_validation = true

  criteria {
    query = "KubeEvents | where TimeGenerated > ago(2m) | where Namespace == \"${var.app_namespace}\" | where Reason in (\"BackOff\", \"OOMKilled\", \"CrashLoopBackOff\")"

    time_aggregation_method = "Count"
    operator                = "GreaterThan"
    threshold               = 0

    failing_periods {
      number_of_evaluation_periods = 1
      minimum_failing_periods_to_trigger_alert = 1
    }
  }

  action {
    action_groups     = var.action_group_ids
    custom_properties = {
      source   = "azure-sre-agent-sandbox"
      workload = "energy-grid"
    }
  }
}
