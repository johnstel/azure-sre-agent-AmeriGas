# Test doc for domain terminology validation — INVALID fixture.
#
# This fixture deliberately mixes domain vocabulary across tagged sections
# so the validator's negative-path tests can assert violations are found.

## My Bulk Tank

**Domain:** Bulk Tank

The customer's tank gauge shows tank percentage and estimated days until
empty. This section also displays full cylinders and empty cylinders from
the nearest cage inventory, which should never appear here.

## Nearby Exchange Locations

**Domain:** Cylinder Exchange

Each retail location cage shows full cylinders, empty cylinders, and
reserved cylinders. It also shows the customer's gallons remaining and
tank percentage, which belongs only to the Bulk Tank domain.
