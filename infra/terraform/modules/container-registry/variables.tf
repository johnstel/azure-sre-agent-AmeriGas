# =============================================================================
# Container Registry Module - Variables
# =============================================================================

variable "name" {
  description = "Name of the container registry (must be globally unique)"
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

variable "sku" {
  description = "SKU for the container registry"
  type        = string
  default     = "Basic"

  validation {
    condition     = contains(["Basic", "Standard", "Premium"], var.sku)
    error_message = "Must be one of: Basic, Standard, Premium."
  }
}

variable "admin_user_enabled" {
  description = "Enable admin user for local development"
  type        = bool
  default     = true
}
