(function (root) {
  function normalizeServiceState(service) {
    if (!service) return { ok: true, code: 'unknown', degraded: false, name: 'Service' };
    if (typeof service.ok === 'boolean') {
      return {
        ok: service.ok,
        code: service.code || service.status || (service.ok ? 200 : 500),
        degraded: !service.ok,
        name: service.name || 'Service',
      };
    }
    const numericStatus = Number(service.status || service.code || 0);
    const ok = service.status === undefined && service.code === undefined ? true : numericStatus >= 200 && numericStatus < 500;
    return {
      ok,
      code: numericStatus || 'unknown',
      degraded: !ok,
      name: service.name || 'Service',
    };
  }

  function isStale(updatedAt, staleAfterMs = 30000) {
    if (!updatedAt) return false;
    const timestamp = new Date(updatedAt).getTime();
    if (Number.isNaN(timestamp)) return false;
    return Date.now() - timestamp > staleAfterMs;
  }

  function derivePortalState(serviceResults, portalName, staleAfterMs = 30000) {
    const serviceResultsSafe = serviceResults || {};
    const results = {
      inventory: normalizeServiceState(serviceResultsSafe.inventory),
      tank: normalizeServiceState(serviceResultsSafe.tank),
      orders: normalizeServiceState(serviceResultsSafe.orders),
      mongodb: serviceResultsSafe.mongodb ? normalizeServiceState(serviceResultsSafe.mongodb) : { ok: true, code: 200, degraded: false, name: 'MongoDB' },
      rabbitmq: serviceResultsSafe.rabbitmq ? normalizeServiceState(serviceResultsSafe.rabbitmq) : { ok: true, code: 200, degraded: false, name: 'RabbitMQ' },
    };

    const derivedMongoOk = results.inventory.ok && results.orders.ok && !results.mongodb.degraded;
    const derivedRabbitOk = results.tank.ok && results.orders.ok && !results.rabbitmq.degraded;
    results.mongodb = { ...results.mongodb, ok: derivedMongoOk, degraded: !derivedMongoOk, code: derivedMongoOk ? 200 : 503 };
    results.rabbitmq = { ...results.rabbitmq, ok: derivedRabbitOk, degraded: !derivedRabbitOk, code: derivedRabbitOk ? 200 : 503 };

    const relevantKeys = portalName === 'customer'
      ? ['inventory', 'tank', 'mongodb', 'rabbitmq']
      : ['orders', 'mongodb', 'rabbitmq', 'tank'];

    const lastUpdated = serviceResults && serviceResults.updatedAt ? serviceResults.updatedAt : new Date().toISOString();
    const stale = isStale(lastUpdated, staleAfterMs);
    const degraded = relevantKeys.some((key) => results[key].degraded) || stale;
    const status = degraded ? 'degraded' : 'healthy';
    const message = degraded
      ? 'Customer-facing data is temporarily delayed while the propane platform reconnects.'
      : 'Live operational data is current.';

    const state = {
      status,
      degraded,
      stale,
      lastUpdated,
      message,
      services: results,
    };

    if (portalName === 'dispatch') {
      state.message = degraded
        ? 'Operations data is temporarily delayed while the dispatch pipeline recovers.'
        : 'Live dispatch telemetry is current.';
    }

    return state;
  }

  const portalHealthState = {
    normalizeServiceState,
    isStale,
    derivePortalState,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = portalHealthState;
  }
  root.PortalHealthState = portalHealthState;
})(typeof window !== 'undefined' ? window : globalThis);
