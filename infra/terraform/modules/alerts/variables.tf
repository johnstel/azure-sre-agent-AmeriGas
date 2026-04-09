# =============================================================================
# Alerts Module - Variables
# =============================================================================

variable "name_prefix" {
  description = "Prefix used for alert names"
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

variable "log_analytics_workspace_id" {
  description = "Log Analytics workspace resource ID"
  type        = string
}

variable "app_namespace" {
  description = "Application namespace to monitor"
  type        = string
  default     = "energy"
}

variable "action_group_ids" {
  description = "Optional action group resource IDs for alert notifications"
  type        = list(string)
  default     = []
}
