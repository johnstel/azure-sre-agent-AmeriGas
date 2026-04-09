# =============================================================================
# AKS Module - Variables
# =============================================================================

variable "name" {
  description = "Name of the AKS cluster"
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

variable "kubernetes_version" {
  description = "Kubernetes version"
  type        = string
}

variable "system_node_vm_size" {
  description = "VM size for system node pool"
  type        = string
}

variable "user_node_vm_size" {
  description = "VM size for user node pool"
  type        = string
}

variable "system_node_count" {
  description = "System node pool node count"
  type        = number
}

variable "user_node_count" {
  description = "User node pool node count"
  type        = number
}

variable "vnet_subnet_id" {
  description = "Subnet ID for AKS nodes"
  type        = string
}

variable "log_analytics_workspace_id" {
  description = "Log Analytics workspace ID for Container Insights"
  type        = string
}

variable "acr_id" {
  description = "Azure Container Registry ID for image pull permissions"
  type        = string
}
