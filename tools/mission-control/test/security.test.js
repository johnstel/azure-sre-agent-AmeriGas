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

test('isLocalRequest ignores forwarded headers and only trusts the socket peer address', () => {
  const headerCases = [
    ['x-forwarded-for', '127.0.0.1'],
    ['x-forwarded-for', '::1'],
    ['x-forwarded-for', '127.0.0.1, 10.0.0.13'],
    ['forwarded', 'for=127.0.0.1;proto=https'],
    ['x-real-ip', '127.0.0.1'],
  ];

  for (const [header, value] of headerCases) {
    const req = {
      socket: { remoteAddress: '203.0.113.10' },
      connection: {},
      headers: { [header]: value },
    };

    assert.equal(isLocalRequest(req), false, `${header}=${value} should not bypass loopback checks`);
  }

  assert.equal(isLocalRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' }, connection: {}, headers: {} }), true);
});
