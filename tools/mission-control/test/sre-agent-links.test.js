const test = require('node:test');
const assert = require('node:assert/strict');
const { toSafeHttpUrl, getSreAgentLinks } = require('../sre-agent-links');

test('toSafeHttpUrl accepts plain https/http URLs', () => {
  assert.equal(toSafeHttpUrl('https://aka.ms/sreagent/portal'), 'https://aka.ms/sreagent/portal');
  assert.equal(toSafeHttpUrl('http://localhost:3000/thread/1'), 'http://localhost:3000/thread/1');
});

test('toSafeHttpUrl rejects non-http(s) protocols', () => {
  assert.equal(toSafeHttpUrl('javascript:alert(1)'), null);
  assert.equal(toSafeHttpUrl('file:///etc/passwd'), null);
  assert.equal(toSafeHttpUrl('ftp://example.com/x'), null);
});

test('toSafeHttpUrl rejects URLs with embedded credentials', () => {
  assert.equal(toSafeHttpUrl('https://user:pass@example.com/thread'), null);
});

test('toSafeHttpUrl rejects malformed input', () => {
  assert.equal(toSafeHttpUrl(''), null);
  assert.equal(toSafeHttpUrl(null), null);
  assert.equal(toSafeHttpUrl(undefined), null);
  assert.equal(toSafeHttpUrl('not a url'), null);
});

test('getSreAgentLinks returns null links when not configured, never a fabricated default', () => {
  const links = getSreAgentLinks({});
  assert.equal(links.threadUrl, null);
  assert.equal(links.analyticsUrl, null);
});

test('getSreAgentLinks returns validated links only when configured safely', () => {
  const links = getSreAgentLinks({
    MISSION_CONTROL_SRE_AGENT_THREAD_URL: 'https://aka.ms/sreagent/portal/thread/123',
    MISSION_CONTROL_SRE_AGENT_ANALYTICS_URL: 'https://user:pw@aka.ms/sreagent/analytics',
  });
  assert.equal(links.threadUrl, 'https://aka.ms/sreagent/portal/thread/123');
  assert.equal(links.analyticsUrl, null, 'a URL with embedded credentials must be rejected even if configured');
});
