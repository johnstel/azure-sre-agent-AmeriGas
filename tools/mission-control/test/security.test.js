const test = require('node:test');
const assert = require('node:assert/strict');
const { createCsrfTokenStore, validateWorkloadName, validateResourceName, getAllowedOrigin, isLocalRequest } = require('../security');

test('validateWorkloadName rejects unsafe workload names', () => {
  assert.throws(() => validateWorkloadName('Bad_Name', 'workloadName'), /3-10 lowercase letters, numbers, or hyphens/);
  assert.throws(() => validateWorkloadName('ab', 'workloadName'), /3-10 lowercase letters, numbers, or hyphens/);
  assert.equal(validateWorkloadName('srelab-01', 'workloadName'), 'srelab-01');
});

test('validateResourceName only accepts safe resource names', () => {
  assert.equal(validateResourceName('rg-srelab-eastus2', 'resourceGroupName'), 'rg-srelab-eastus2');
  assert.throws(() => validateResourceName('bad;name', 'resourceGroupName'), /only letters, numbers/);
});

test('csrf tokens are single-use and loopback origins are allowed', () => {
  const tokenStore = createCsrfTokenStore();
  const token = tokenStore.issue();
  assert.equal(tokenStore.validate(token), true);
  assert.equal(tokenStore.validate(token), false);

  const req = {
    get(name) {
      if (name === 'origin') return 'http://127.0.0.1:3000';
      return null;
    },
    hostname: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    headers: {},
  };

  assert.equal(getAllowedOrigin(req), 'http://127.0.0.1:3000');
  assert.equal(isLocalRequest(req), true);
});
