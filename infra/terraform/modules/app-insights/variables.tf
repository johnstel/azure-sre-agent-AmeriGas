# =============================================================================
# Application Insights Module - Variables
# =============================================================================

variable "name" {
  description = "Name of the Application Insights resource"
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

variable "workspace_id" {
  description = "Log Analytics workspace ID to send telemetry to"
  type        = string
}

variable "application_type" {
  description = "Application type"
  type        = string
  default     = "web"

  validation {
    condition     = contains(["web", "other"], var.application_type)
    error_message = "Must be one of: web, other."
  }
}
