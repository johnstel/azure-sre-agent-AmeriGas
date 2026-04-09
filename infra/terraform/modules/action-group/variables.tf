# =============================================================================
# Action Group Module - Variables
# =============================================================================

variable "name" {
  description = "Action Group name"
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

variable "short_name" {
  description = "Action Group short name (max 12 chars)"
  type        = string
  default     = "srelabops"

  validation {
    condition     = length(var.short_name) <= 12
    error_message = "Short name must be 12 characters or fewer."
  }
}

variable "webhook_service_uri" {
  description = "Optional webhook/Logic App callback URL for incident routing"
  type        = string
  default     = ""
  sensitive   = true
}
