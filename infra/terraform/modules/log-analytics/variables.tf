# =============================================================================
# Log Analytics Module - Variables
# =============================================================================

variable "name" {
  description = "Name of the Log Analytics workspace"
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

variable "retention_in_days" {
  description = "Data retention period in days (30-730)"
  type        = number
  default     = 30

  validation {
    condition     = var.retention_in_days >= 30 && var.retention_in_days <= 730
    error_message = "Retention must be between 30 and 730 days."
  }
}

variable "sku" {
  description = "SKU for the workspace"
  type        = string
  default     = "PerGB2018"

  validation {
    condition     = contains(["PerGB2018", "Free", "Standalone", "PerNode"], var.sku)
    error_message = "Must be one of: PerGB2018, Free, Standalone, PerNode."
  }
}
