# =============================================================================
# SRE Agent Module
# =============================================================================
# Deploys an Azure SRE Agent with managed identity and role assignments.
# Uses azapi provider since Microsoft.App/agents@2025-05-01-preview is not
# yet available in the azurerm provider.
# =============================================================================

locals {
  identity_name = "${var.agent_name}-${var.unique_suffix}"

  # Built-in Azure RBAC role definition GUIDs, named explicitly so the
  # GUID-to-role mapping is verifiable and can't silently drift out of sync
  # with its label (mirrors infra/bicep/modules/sre-agent.bicep). Verified
  # against `az role definition list --query "[?name=='<guid>'].{name:roleName}"`.
  role_definition_ids = {
    log_analytics_reader      = "73c42c96-874c-492b-b04d-ab87d138a893" # Log Analytics Reader — read-only query access
    log_analytics_contributor = "92aaf0da-9dab-42b6-94a3-d43ce8d16293" # Log Analytics Contributor — manage saved searches/alerts, required for approved remediation
    reader                    = "acdd72a7-3385-48ef-bd42-f606fba81ae7" # Reader
    contributor               = "b24988ac-6180-42a0-ab88-20f7382dd24c" # Contributor
  }

  # Role definition IDs by access level. Low is strictly read-only (diagnosis
  # only, no remediation). High adds Contributor (full remediation) and Log
  # Analytics Contributor (manage/act on Log Analytics saved searches and
  # alerts as part of approved remediation) — deliberately, not a mislabeled
  # Reader.
  role_definitions = {
    Low = [
      local.role_definition_ids.log_analytics_reader,
      local.role_definition_ids.reader,
    ]
    High = [
      local.role_definition_ids.log_analytics_contributor,
      local.role_definition_ids.reader,
      local.role_definition_ids.contributor,
    ]
  }

  selected_roles = local.role_definitions[var.access_level]
}

data "azurerm_resource_group" "main" {
  name = var.resource_group_name
}

data "azurerm_client_config" "current" {}

# User-Assigned Managed Identity for SRE Agent
resource "azurerm_user_assigned_identity" "sre_agent" {
  name                = local.identity_name
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = var.tags
}

# Role assignments for the managed identity on the resource group
resource "azurerm_role_assignment" "sre_agent" {
  count = length(local.selected_roles)

  scope              = data.azurerm_resource_group.main.id
  role_definition_id = "/providers/Microsoft.Authorization/roleDefinitions/${local.selected_roles[count.index]}"
  principal_id       = azurerm_user_assigned_identity.sre_agent.principal_id
  principal_type     = "ServicePrincipal"
}

# SRE Agent (preview resource via azapi)
resource "azapi_resource" "sre_agent" {
  type                      = "Microsoft.App/agents@2025-05-01-preview"
  name                      = var.agent_name
  location                  = var.location
  parent_id                 = data.azurerm_resource_group.main.id
  tags                      = var.tags
  schema_validation_enabled = false

  identity {
    type         = "SystemAssigned, UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.sre_agent.id]
  }

  body = jsonencode({
    properties = {
      knowledgeGraphConfiguration = {
        identity         = azurerm_user_assigned_identity.sre_agent.id
        managedResources = [data.azurerm_resource_group.main.id]
      }
      actionConfiguration = {
        accessLevel = var.access_level
        identity    = azurerm_user_assigned_identity.sre_agent.id
        mode        = "Review"
      }
      logConfiguration = {
        applicationInsightsConfiguration = {
          appId            = var.app_insights_app_id
          connectionString = var.app_insights_connection_string
        }
      }
    }
  })

  depends_on = [azurerm_role_assignment.sre_agent]
}

# Assign SRE Agent Administrator role to the deployer
resource "azurerm_role_assignment" "sre_agent_admin" {
  scope              = azapi_resource.sre_agent.id
  role_definition_id = "/providers/Microsoft.Authorization/roleDefinitions/e79298df-d852-4c6d-84f9-5d13249d1e55" # SRE Agent Administrator
  principal_id       = data.azurerm_client_config.current.object_id
  principal_type     = "User"
}
