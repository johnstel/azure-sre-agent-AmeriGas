/**
 * Canonical ZavaGas breakable-scenario catalog.
 *
 * This is the single source of truth for the scenario id -> manifest
 * filename mapping (previously duplicated in server.js and copilot-tools.js)
 * plus the metadata used to seed an incident record: display name, domain
 * (Bulk Tank / Cylinder Exchange / Shared), the primarily impacted service,
 * and any deterministic correlation ids introduced by prior scenario work
 * (e.g. the Bulk Tank Safety Alarm id from issue #6, or the refill-order
 * backlog ids from issue #7) that should be carried into the incident
 * timeline as "related ids" so evidence can be cross-referenced.
 */

const SCENARIO_MAP = {
  oom: 'oom-killed.yaml',
  crash: 'crash-loop.yaml',
  image: 'image-pull-backoff.yaml',
  cpu: 'high-cpu.yaml',
  pending: 'pending-pods.yaml',
  probe: 'probe-failure.yaml',
  backlog: 'refill-order-backlog.yaml',
  latency: 'dependency-latency.yaml',
  network: 'network-block.yaml',
  config: 'missing-config.yaml',
  mongodb: 'mongodb-down.yaml',
  service: 'service-mismatch.yaml',
  latency: 'dependency-latency.yaml',
};

const SCENARIO_METADATA = {
  oom: {
    name: 'OOMKilled',
    domain: 'Bulk Tank',
    impactedService: 'tank-monitor',
    narrative: 'Tank monitor overwhelmed by winter peak bulk-tank sensor readings',
    relatedIds: [],
  },
  crash: {
    name: 'CrashLoopBackOff',
    domain: 'Shared',
    impactedService: 'inventory-service',
    narrative: 'Inventory service crash from invalid pricing configuration',
    relatedIds: [],
  },
  image: {
    name: 'ImagePullBackOff',
    domain: 'Shared',
    impactedService: 'order-service',
    narrative: 'Order service fails after a botched image release',
    relatedIds: [],
  },
  cpu: {
    name: 'High CPU',
    domain: 'Cylinder Exchange',
    impactedService: 'demand-forecast-overload',
    narrative: 'Demand forecast overload during peak heating season',
    relatedIds: [],
  },
  pending: {
    name: 'Pending Pods',
    domain: 'Shared',
    impactedService: 'fleet-telemetry-monitor',
    narrative: "Fleet telemetry monitor can't be scheduled",
    relatedIds: [],
  },
  probe: {
    name: 'Bulk Tank Safety Alarm',
    domain: 'Bulk Tank',
    impactedService: 'safety-compliance-monitor',
    narrative: 'Simulated rapid tank-level drop with suppressed alarm processing',
    relatedIds: ['BT-SAFETY-ALM-00042', 'BT-1551'],
  },
  backlog: {
    name: 'Refill Order Backlog',
    domain: 'Shared',
    impactedService: 'refill-order-backlog-simulator',
    narrative: 'RabbitMQ refill backlog grows while producers remain healthy and a malformed refill event is retried before DLQ routing',
    relatedIds: ['RO-1041', 'RO-1042', 'RO-1043', 'RO-1044', 'EV-REFILL-2047'],
  },
  latency: {
    name: 'Dependency Latency',
    domain: 'Shared',
    impactedService: 'order-pricing-dependency',
    narrative: 'The pricing-lookup dependency gradually slows from 45ms up toward 950ms while the service remains Running/Ready and the SLO is breached without a crash.',
    relatedIds: ['OPD-INC-22', 'ORD-PRICING-LOOKUP-LATENCY'],
  },
  network: {
    name: 'Network Block',
    domain: 'Bulk Tank',
    impactedService: 'tank-monitor',
    narrative: 'Tank monitor isolated by an overly restrictive NetworkPolicy',
    relatedIds: [],
  },
  config: {
    name: 'Missing Config',
    domain: 'Shared',
    impactedService: 'delivery-zone-config',
    narrative: 'Delivery zone configuration missing',
    relatedIds: [],
  },
  mongodb: {
    name: 'MongoDB Down',
    domain: 'Shared',
    impactedService: 'mongodb',
    narrative: 'Tank database outage causing a cascading failure',
    relatedIds: [],
  },
  service: {
    name: 'Service Mismatch',
    domain: 'Bulk Tank',
    impactedService: 'tank-monitor',
    narrative: 'Tank monitor Service selector drift after a "v2 upgrade"',
    relatedIds: [],
  },
  latency: {
    name: 'Dependency Latency',
    domain: 'Shared',
    impactedService: 'order-pricing-dependency',
    narrative: 'Order checkout pricing-lookup dependency gradually slows down after an emergency timeout config change, while all pods remain Ready and error rate stays low',
    relatedIds: [],
  },
};

module.exports = { SCENARIO_MAP, SCENARIO_METADATA };
