# =============================================================================
# Network Module
# =============================================================================
# Creates a VNet with subnets for AKS and other services. Network configuration
# is important for SRE Agent - ensure the cluster is not completely isolated
# from inbound traffic to allow SRE Agent access.
# =============================================================================

resource "azurerm_virtual_network" "main" {
  name                = var.vnet_name
  location            = var.location
  resource_group_name = var.resource_group_name
  address_space       = [var.address_prefix]
  tags                = var.tags
}

resource "azurerm_subnet" "aks" {
  name                              = "snet-aks"
  resource_group_name               = var.resource_group_name
  virtual_network_name              = azurerm_virtual_network.main.name
  address_prefixes                  = [var.aks_subnet_prefix]
  private_endpoint_network_policies = "Disabled"
}

resource "azurerm_subnet" "services" {
  name                              = "snet-services"
  resource_group_name               = var.resource_group_name
  virtual_network_name              = azurerm_virtual_network.main.name
  address_prefixes                  = [var.services_subnet_prefix]
  private_endpoint_network_policies = "Disabled"
}
