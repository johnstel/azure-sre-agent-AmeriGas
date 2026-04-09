# =============================================================================
# AKS Module
# =============================================================================
# Deploys an AKS cluster configured for SRE Agent monitoring and diagnosis.
#
# IMPORTANT FOR SRE AGENT:
# - Cluster must NOT have fully restricted inbound network access
# - Container Insights and OIDC Issuer must be enabled
# - Workload Identity should be enabled for secure service auth
# =============================================================================

resource "azurerm_kubernetes_cluster" "main" {
  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = var.tags
  dns_prefix          = var.name
  kubernetes_version  = var.kubernetes_version

  sku_tier = "Standard" # Standard tier for SLA - recommended for demos

  identity {
    type = "SystemAssigned"
  }

  # Enable features needed for SRE Agent
  oidc_issuer_enabled       = true
  workload_identity_enabled = true

  # Network configuration - PUBLIC networking to allow SRE Agent access
  network_profile {
    network_plugin = "azure"
    network_policy = "calico"
    load_balancer_sku = "standard"
    service_cidr   = "10.1.0.0/16"
    dns_service_ip = "10.1.0.10"
  }

  # API server access - Enable public access for SRE Agent
  api_server_access_profile {
    authorized_ip_ranges = null
  }

  # System node pool
  default_node_pool {
    name                = "system"
    node_count          = var.system_node_count
    vm_size             = var.system_node_vm_size
    os_sku              = "AzureLinux"
    vnet_subnet_id      = var.vnet_subnet_id
    auto_scaling_enabled = true
    min_count           = 1
    max_count           = 5
    only_critical_addons_enabled = true

    node_labels = {
      "nodepool-type" = "system"
    }
  }

  # Container Insights
  oms_agent {
    log_analytics_workspace_id = var.log_analytics_workspace_id
    msi_auth_for_monitoring_enabled = true
  }

  # Azure Policy
  azure_policy_enabled = true

  # Key Vault Secrets Provider
  key_vault_secrets_provider {
    secret_rotation_enabled  = true
    secret_rotation_interval = "2m"
  }

  # Azure Monitor metrics
  monitor_metrics {
    annotations_allowed = "*"
    labels_allowed      = "*"
  }

  # Auto-upgrade channel
  automatic_upgrade_channel   = "stable"
  node_os_upgrade_channel     = "NodeImage"
}

# User (workload) node pool
resource "azurerm_kubernetes_cluster_node_pool" "workload" {
  name                  = "workload"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.main.id
  vm_size               = var.user_node_vm_size
  os_sku                = "AzureLinux"
  vnet_subnet_id        = var.vnet_subnet_id
  node_count            = var.user_node_count
  auto_scaling_enabled  = true
  min_count             = 1
  max_count             = 10
  mode                  = "User"

  node_labels = {
    "nodepool-type" = "user"
  }
}

# Grant AKS access to ACR for image pulls
resource "azurerm_role_assignment" "aks_acr_pull" {
  scope                = var.acr_id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_kubernetes_cluster.main.kubelet_identity[0].object_id
  principal_type       = "ServicePrincipal"
}
