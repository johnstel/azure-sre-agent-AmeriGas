# =============================================================================
# Network Module - Variables
# =============================================================================

variable "vnet_name" {
  description = "Name of the virtual network"
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

variable "address_prefix" {
  description = "Address prefix for the VNet"
  type        = string
  default     = "10.0.0.0/16"
}

variable "aks_subnet_prefix" {
  description = "Address prefix for the AKS subnet"
  type        = string
  default     = "10.0.0.0/22"
}

variable "services_subnet_prefix" {
  description = "Address prefix for services subnet (private endpoints)"
  type        = string
  default     = "10.0.4.0/24"
}
