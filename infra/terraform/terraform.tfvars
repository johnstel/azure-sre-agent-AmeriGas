# =============================================================================
# Default Variable Values - Energy Grid SRE Agent Sandbox
# =============================================================================
# Copy this file to terraform.tfvars and update subscription_id before deploying.
# Deploy with: terraform init && terraform apply
# =============================================================================

subscription_id = "" # Set your Azure subscription ID

location      = "eastus2"
workload_name = "srelab"

# Observability stack (Grafana + Prometheus)
deploy_observability = true

# Baseline alert rules
deploy_alerts = false

# Deploy Azure SRE Agent (programmatic deployment now supported)
deploy_sre_agent = true

# Default action group for incident routing
deploy_action_group = false

# AKS Configuration - cost-optimized for demo
kubernetes_version = "1.32"
system_node_vm_size = "Standard_D2s_v5"
user_node_vm_size   = "Standard_D2s_v5"
system_node_count   = 2
user_node_count     = 3

# Tags
tags = {
  workload    = "energy-grid-demo"
  environment = "sandbox"
  managedBy   = "terraform"
  purpose     = "energy-sre-demo"
  costCenter  = "energy-demo-lab"
}
