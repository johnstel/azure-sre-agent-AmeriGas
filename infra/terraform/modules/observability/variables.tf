# =============================================================================
# Observability Module - Variables
# =============================================================================

variable "grafana_name" {
  description = "Name of the Managed Grafana workspace"
  type        = string
}

variable "prometheus_name" {
  description = "Name of the Azure Monitor workspace for Prometheus"
  type        = string
}

variable "location" {
  description = "Azure region for deployment"
  type        = string
}

variable "resource_group_name" {
  description = "Name of the resource group"
  type        = string
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
}

variable "aks_cluster_id" {
  description = "AKS cluster ID to monitor"
  type        = string
}
