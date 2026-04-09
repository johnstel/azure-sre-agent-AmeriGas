# =============================================================================
# Observability Stack Module
# =============================================================================
# Deploys Azure Managed Grafana and Azure Monitor managed service for
# Prometheus. These integrate with SRE Agent for comprehensive monitoring.
# =============================================================================

# Azure Monitor Workspace for Prometheus
resource "azurerm_monitor_workspace" "main" {
  name                = var.prometheus_name
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = var.tags
}

# Data collection endpoint
resource "azurerm_monitor_data_collection_endpoint" "prometheus" {
  name                          = "${var.prometheus_name}-dce"
  location                      = var.location
  resource_group_name           = var.resource_group_name
  tags                          = var.tags
  public_network_access_enabled = true
}

# Data collection rule for Prometheus metrics
resource "azurerm_monitor_data_collection_rule" "prometheus" {
  name                        = "${var.prometheus_name}-dcr"
  location                    = var.location
  resource_group_name         = var.resource_group_name
  tags                        = var.tags
  data_collection_endpoint_id = azurerm_monitor_data_collection_endpoint.prometheus.id

  data_sources {
    prometheus_forwarder {
      name    = "PrometheusDataSource"
      streams = ["Microsoft-PrometheusMetrics"]
    }
  }

  destinations {
    monitor_account {
      monitor_account_id = azurerm_monitor_workspace.main.id
      name               = "MonitoringAccount"
    }
  }

  data_flow {
    streams      = ["Microsoft-PrometheusMetrics"]
    destinations = ["MonitoringAccount"]
  }
}

# DCE association - must be named 'configurationAccessEndpoint' per Azure requirements
resource "azurerm_monitor_data_collection_rule_association" "prometheus_dce" {
  name                        = "configurationAccessEndpoint"
  target_resource_id          = var.aks_cluster_id
  data_collection_endpoint_id = azurerm_monitor_data_collection_endpoint.prometheus.id
}

# DCR association
resource "azurerm_monitor_data_collection_rule_association" "prometheus_dcr" {
  name                    = "${var.prometheus_name}-dcr-association"
  target_resource_id      = var.aks_cluster_id
  data_collection_rule_id = azurerm_monitor_data_collection_rule.prometheus.id
}

# Azure Managed Grafana
resource "azurerm_dashboard_grafana" "main" {
  name                              = var.grafana_name
  location                          = var.location
  resource_group_name               = var.resource_group_name
  tags                              = var.tags
  sku                               = "Standard"
  zone_redundancy_enabled           = false
  api_key_enabled                   = false
  deterministic_outbound_ip_enabled = false
  public_network_access_enabled     = true
  grafana_major_version             = "11"

  identity {
    type = "SystemAssigned"
  }

  azure_monitor_workspace_integrations {
    resource_id = azurerm_monitor_workspace.main.id
  }
}

# Grant Grafana Monitoring Reader on the resource group
resource "azurerm_role_assignment" "grafana_monitoring_reader" {
  scope                = "/subscriptions/${data.azurerm_subscription.current.subscription_id}"
  role_definition_name = "Monitoring Reader"
  principal_id         = azurerm_dashboard_grafana.main.identity[0].principal_id
  principal_type       = "ServicePrincipal"
}

data "azurerm_subscription" "current" {}
