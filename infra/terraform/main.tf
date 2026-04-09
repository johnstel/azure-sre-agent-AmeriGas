# =============================================================================
# Azure SRE Agent Energy Grid Demo Lab - Main Terraform Configuration
# =============================================================================
# This template deploys an AKS cluster with a multi-pod energy grid platform,
# along with supporting infrastructure for demonstrating Azure SRE Agent
# capabilities for diagnostics and troubleshooting.
# =============================================================================

locals {
  resource_group_name = "rg-${var.workload_name}-${var.location}"
  unique_suffix       = substr(sha256("${data.azurerm_subscription.current.subscription_id}${local.resource_group_name}"), 0, 6)

  names = {
    aks              = "aks-${var.workload_name}"
    acr              = "acr${var.workload_name}${local.unique_suffix}"
    log_analytics    = "log-${var.workload_name}"
    app_insights     = "appi-${var.workload_name}"
    grafana          = "grafana-${var.workload_name}-${local.unique_suffix}"
    prometheus       = "prometheus-${var.workload_name}"
    key_vault        = "kv-${var.workload_name}-${local.unique_suffix}"
    managed_identity = "id-${var.workload_name}"
    vnet             = "vnet-${var.workload_name}"
    sre_agent        = "sre-${var.workload_name}"
  }
}

data "azurerm_subscription" "current" {}
data "azurerm_client_config" "current" {}

# =============================================================================
# RESOURCE GROUP
# =============================================================================

resource "azurerm_resource_group" "main" {
  name     = local.resource_group_name
  location = var.location
  tags     = merge(var.tags, { SecurityControl = "Ignore" })
}

# =============================================================================
# MODULES
# =============================================================================

# Log Analytics Workspace (required for AKS monitoring and SRE Agent)
module "log_analytics" {
  source = "./modules/log-analytics"

  name                = local.names.log_analytics
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = var.tags
  retention_in_days   = 30
}

# Application Insights (for application-level telemetry)
module "app_insights" {
  source = "./modules/app-insights"

  name                = local.names.app_insights
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = var.tags
  workspace_id        = module.log_analytics.workspace_id
}

# Virtual Network for AKS
module "network" {
  source = "./modules/network"

  vnet_name              = local.names.vnet
  location               = azurerm_resource_group.main.location
  resource_group_name    = azurerm_resource_group.main.name
  tags                   = var.tags
  address_prefix         = "10.0.0.0/16"
  aks_subnet_prefix      = "10.0.0.0/22"
  services_subnet_prefix = "10.0.4.0/24"
}

# Azure Container Registry
module "container_registry" {
  source = "./modules/container-registry"

  name                = local.names.acr
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = var.tags
  sku                 = "Basic"
}

# Azure Kubernetes Service
module "aks" {
  source = "./modules/aks"

  name                       = local.names.aks
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  tags                       = var.tags
  kubernetes_version         = var.kubernetes_version
  system_node_vm_size        = var.system_node_vm_size
  user_node_vm_size          = var.user_node_vm_size
  system_node_count          = var.system_node_count
  user_node_count            = var.user_node_count
  vnet_subnet_id             = module.network.aks_subnet_id
  log_analytics_workspace_id = module.log_analytics.workspace_id
  acr_id                     = module.container_registry.acr_id
}

# Key Vault for secrets management
module "key_vault" {
  source = "./modules/key-vault"

  name                     = local.names.key_vault
  location                 = azurerm_resource_group.main.location
  resource_group_name      = azurerm_resource_group.main.name
  tags                     = var.tags
  enable_rbac_authorization = true
  tenant_id                = data.azurerm_client_config.current.tenant_id
}

# Azure SRE Agent (optional)
module "sre_agent" {
  source = "./modules/sre-agent"
  count  = var.deploy_sre_agent ? 1 : 0

  agent_name                        = local.names.sre_agent
  location                          = azurerm_resource_group.main.location
  resource_group_name               = azurerm_resource_group.main.name
  tags                              = var.tags
  access_level                      = "High"
  app_insights_app_id               = module.app_insights.app_id
  app_insights_connection_string    = module.app_insights.connection_string
  unique_suffix                     = local.unique_suffix
}

# Observability Stack - Managed Grafana and Prometheus (optional)
module "observability" {
  source = "./modules/observability"
  count  = var.deploy_observability ? 1 : 0

  grafana_name        = local.names.grafana
  prometheus_name     = local.names.prometheus
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = var.tags
  aks_cluster_id      = module.aks.aks_id
}

# Default Action Group (optional)
module "action_group" {
  source = "./modules/action-group"
  count  = var.deploy_action_group ? 1 : 0

  name                = "ag-${var.workload_name}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = var.tags
  short_name          = var.action_group_short_name
  webhook_service_uri = var.incident_webhook_service_uri
}

# Alerts (optional)
module "alerts" {
  source = "./modules/alerts"
  count  = var.deploy_alerts ? 1 : 0

  name_prefix                = "alert-${var.workload_name}"
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  tags                       = var.tags
  log_analytics_workspace_id = module.log_analytics.workspace_id
  app_namespace              = "energy"
  action_group_ids           = var.deploy_action_group ? concat(var.alert_action_group_ids, [module.action_group[0].action_group_id]) : var.alert_action_group_ids
}
