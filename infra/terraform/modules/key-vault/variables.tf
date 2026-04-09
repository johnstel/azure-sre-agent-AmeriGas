# =============================================================================
# Key Vault Module - Variables
# =============================================================================

variable "name" {
  description = "Name of the Key Vault"
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

variable "tenant_id" {
  description = "Azure AD tenant ID"
  type        = string
}

variable "enable_rbac_authorization" {
  description = "Enable RBAC authorization (recommended)"
  type        = bool
  default     = true
}

variable "sku_name" {
  description = "SKU for Key Vault"
  type        = string
  default     = "standard"

  validation {
    condition     = contains(["standard", "premium"], var.sku_name)
    error_message = "Must be one of: standard, premium."
  }
}
