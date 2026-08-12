# Test doc for domain terminology validation — VALID fixture.
#
# This fixture demonstrates correct domain separation: Bulk Tank vocabulary
# (gallons, tank percentage, days until empty) only appears in Bulk Tank
# zones, and Cylinder Exchange vocabulary (full/empty/reserved cylinder
# counts, cage inventory) only appears in Cylinder Exchange zones.

## My Bulk Tank

**Domain:** Bulk Tank

The customer's tank gauge shows tank percentage and estimated days until
empty. Current price is $2.45/gal. Consumption history is tracked in
gallons per day.

## Nearby Exchange Locations

**Domain:** Cylinder Exchange

Each retail location cage shows full cylinders, empty cylinders, and
reserved cylinders. Cage inventory is refreshed every 10 seconds and cage
restock is scheduled based on daily cylinder turnover.

## Shared Infrastructure

**Domain:** Shared

Order Service processes both bulk tank delivery orders and cylinder
exchange cage restock orders through the same MongoDB-backed queue.
