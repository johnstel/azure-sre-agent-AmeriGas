# =============================================================================
# SRE Agent Module - Variables
# =============================================================================

variable "agent_name" {
  description = "Name of the SRE Agent"
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

variable "access_level" {
  description = "The access level for the SRE Agent (High or Low)"
  type        = string
  default     = "High"

  validation {
    condition     = contains(["High", "Low"], var.access_level)
    error_message = "Must be one of: High, Low."
  }
}

variable "app_insights_app_id" {
  description = "Application Insights App ID"
  type        = string
}

variable "app_insights_connection_string" {
  description = "Application Insights connection string"
  type        = string
  sensitive   = true
}

variable "unique_suffix" {
  description = "Unique suffix for resource naming"
  type        = string
}
