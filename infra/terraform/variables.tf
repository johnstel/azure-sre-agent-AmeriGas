# =============================================================================
# Azure SRE Agent Energy Grid Demo Lab - Input Variables
# =============================================================================

variable "subscription_id" {
  description = "Azure subscription ID to deploy into"
  type        = string
}

variable "workload_name" {
  description = "Name of the workload (used for naming resources)"
  type        = string
  default     = "srelab"

  validation {
    condition     = length(var.workload_name) >= 3 && length(var.workload_name) <= 10
    error_message = "Workload name must be between 3 and 10 characters."
  }
}

variable "location" {
  description = "Azure region for deployment. Must be a region supporting SRE Agent."
  type        = string
  default     = "eastus2"

  validation {
    condition     = contains(["eastus2", "swedencentral", "australiaeast"], var.location)
    error_message = "Location must be one of: eastus2, swedencentral, australiaeast."
  }
}

variable "deploy_observability" {
  description = "Deploy full observability stack (Managed Grafana, Prometheus)"
  type        = bool
  default     = true
}

variable "deploy_alerts" {
  description = "Deploy baseline Azure Monitor alert rules for AKS and app telemetry"
  type        = bool
  default     = false
}

variable "deploy_sre_agent" {
  description = "Deploy Azure SRE Agent for AI-powered diagnostics and remediation"
  type        = bool
  default     = true
}

variable "deploy_action_group" {
  description = "Deploy default Action Group for alert notifications and incident routing"
  type        = bool
  default     = false
}

variable "action_group_short_name" {
  description = "Action Group short name (max 12 characters)"
  type        = string
  default     = "srelabops"

  validation {
    condition     = length(var.action_group_short_name) <= 12
    error_message = "Action Group short name must be 12 characters or fewer."
  }
}

variable "incident_webhook_service_uri" {
  description = "Optional webhook/Logic App callback URL for default Action Group incident routing"
  type        = string
  default     = ""
  sensitive   = true
}

variable "alert_action_group_ids" {
  description = "Optional action group resource IDs to notify when alerts fire"
  type        = list(string)
  default     = []
}

variable "kubernetes_version" {
  description = "AKS Kubernetes version"
  type        = string
  default     = "1.32"
}

variable "system_node_vm_size" {
  description = "AKS system node pool VM size"
  type        = string
  default     = "Standard_D2s_v5"

  validation {
    condition     = contains(["Standard_D2s_v5", "Standard_D4s_v5", "Standard_D2as_v5", "Standard_D4as_v5"], var.system_node_vm_size)
    error_message = "Must be one of: Standard_D2s_v5, Standard_D4s_v5, Standard_D2as_v5, Standard_D4as_v5."
  }
}

variable "user_node_vm_size" {
  description = "AKS user node pool VM size for workloads"
  type        = string
  default     = "Standard_D2s_v5"

  validation {
    condition     = contains(["Standard_D2s_v5", "Standard_D4s_v5", "Standard_D2as_v5", "Standard_D4as_v5"], var.user_node_vm_size)
    error_message = "Must be one of: Standard_D2s_v5, Standard_D4s_v5, Standard_D2as_v5, Standard_D4as_v5."
  }
}

variable "system_node_count" {
  description = "System node pool node count"
  type        = number
  default     = 2

  validation {
    condition     = var.system_node_count >= 1 && var.system_node_count <= 5
    error_message = "System node count must be between 1 and 5."
  }
}

variable "user_node_count" {
  description = "User node pool node count"
  type        = number
  default     = 3

  validation {
    condition     = var.user_node_count >= 1 && var.user_node_count <= 10
    error_message = "User node count must be between 1 and 10."
  }
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default = {
    workload    = "energy-grid-demo"
    environment = "sandbox"
    managedBy   = "terraform"
    purpose     = "energy-sre-demo"
    costCenter  = "energy-demo-lab"
  }
}
