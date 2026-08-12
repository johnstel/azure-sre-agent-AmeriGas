const test = require('node:test');
const assert = require('node:assert/strict');
const { derivePortalState, isStale } = require('../public/portal-health-state');

const now = new Date().toISOString();

test('healthy portal state stays green', () => {
  const state = derivePortalState({
    inventory: { ok: true, status: 200 },
    tank: { ok: true, status: 200 },
    orders: { ok: true, status: 200 },
    updatedAt: now,
  }, 'customer');

  assert.equal(state.status, 'healthy');
  assert.equal(state.degraded, false);
  assert.match(state.message, /current/i);
});

test('HTTP 5xx results degrade the relevant portal', () => {
  const state = derivePortalState({
    inventory: { ok: false, status: 503 },
    tank: { ok: true, status: 200 },
    orders: { ok: true, status: 200 },
    updatedAt: now,
  }, 'customer');

  assert.equal(state.status, 'degraded');
  assert.equal(state.services.inventory.degraded, true);
  assert.equal(state.services.mongodb.degraded, true);
});

test('stale data is flagged when timestamp exceeds the threshold', () => {
  const staleAt = new Date(Date.now() - 60000).toISOString();
  assert.equal(isStale(staleAt, 30000), true);
  assert.equal(isStale(now, 30000), false);
});

test('recovery clears degraded state and restores healthy messaging', () => {
  const degraded = derivePortalState({
    inventory: { ok: false, status: 503 },
    tank: { ok: true, status: 200 },
    orders: { ok: true, status: 200 },
    updatedAt: now,
  }, 'customer');

  const recovered = derivePortalState({
    inventory: { ok: true, status: 200 },
    tank: { ok: true, status: 200 },
    orders: { ok: true, status: 200 },
    updatedAt: now,
  }, 'customer');

  assert.equal(degraded.status, 'degraded');
  assert.equal(recovered.status, 'healthy');
  assert.equal(recovered.message.includes('current'), true);
});
