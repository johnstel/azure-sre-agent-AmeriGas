const test = require('node:test');
const assert = require('node:assert/strict');
const incidentUI = require('../public/incident-timeline-ui');

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.attributes = {};
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name];
  }
}

class FakeDocument {
  createElement(tagName) {
    return new FakeElement(tagName);
  }
}

function flatten(node) {
  const result = [node];
  for (const child of node.children || []) result.push(...flatten(child));
  return result;
}

test('milestoneLabel and finalStateLabel produce human-readable text with safe fallbacks', () => {
  assert.equal(incidentUI.milestoneLabel('impact_detected'), 'First impact observed');
  assert.equal(incidentUI.milestoneLabel('totally_unknown_type'), 'totally_unknown_type');
  assert.equal(incidentUI.finalStateLabel(null), 'In progress');
  assert.equal(incidentUI.finalStateLabel('recovered'), 'Recovered');
  assert.equal(incidentUI.finalStateLabel('partial_recovery'), 'Partial recovery');
});

test('buildScorecard renders "not yet identified" for a missing root cause rather than fabricating one', () => {
  const doc = new FakeDocument();
  const snapshot = {
    correlationId: 'INC-TEST-0001',
    scenarioId: 'oom',
    scenarioName: 'OOMKilled',
    domain: 'Bulk Tank',
    impactedService: 'tank-monitor',
    relatedIds: [],
    finalState: null,
    milestones: [],
    metrics: { timeToDetect: null, timeToRootCause: null, timeToRecover: null },
  };
  const card = incidentUI.buildScorecard(snapshot, doc);
  const allText = flatten(card).map((n) => n.textContent).join(' | ');
  assert.match(allText, /Not yet identified in this run/);
  assert.match(allText, /Not observed in this run/);
  assert.match(allText, /No action proposed in this run/);
  assert.match(allText, /No human-benchmark or ROI figures/);
});

test('buildScorecard surfaces measured metrics and the most recent proposed action when present', () => {
  const doc = new FakeDocument();
  const snapshot = {
    correlationId: 'INC-TEST-0002',
    scenarioId: 'mongodb',
    scenarioName: 'MongoDB Down',
    domain: 'Shared',
    impactedService: 'mongodb',
    relatedIds: [],
    finalState: 'recovered',
    milestones: [
      { type: 'root_cause_identified', data: { statement: 'mongodb replica count is 0' } },
      { type: 'action_proposed', data: { toolName: 'fix_all', runMode: 'operator-direct' } },
    ],
    metrics: { timeToDetect: '5s', timeToRootCause: '12s', timeToRecover: '48s' },
  };
  const card = incidentUI.buildScorecard(snapshot, doc);
  const allText = flatten(card).map((n) => n.textContent).join(' | ');
  assert.match(allText, /mongodb replica count is 0/);
  assert.match(allText, /fix_all \(operator-direct\)/);
  assert.match(allText, /5s/);
  assert.match(allText, /12s/);
  assert.match(allText, /48s/);
  assert.match(allText, /Recovered/);
});

test('buildScorecard escapes malicious root-cause text as plain content, never markup', () => {
  const doc = new FakeDocument();
  const snapshot = {
    correlationId: 'INC-TEST-0003',
    milestones: [{ type: 'root_cause_identified', data: { statement: '<img src=x onerror=alert(1)>' } }],
    metrics: {},
  };
  const card = incidentUI.buildScorecard(snapshot, doc);
  const all = flatten(card);
  assert.equal(all.filter((n) => n.tagName === 'IMG').length, 0);
  assert.ok(all.some((n) => n.textContent.includes('<img src=x onerror=alert(1)>')));
});

test('buildEvidenceSummary marks unused/unavailable categories distinctly from used ones', () => {
  const doc = new FakeDocument();
  const evidence = [
    { category: 'kubernetes', used: true, count: 3, toolNames: ['get_pods'], nativeAvailable: true, nativeDescription: '' },
    { category: 'traces', used: false, count: 0, toolNames: [], nativeAvailable: false, nativeDescription: 'not wired into this tool set' },
  ];
  const container = incidentUI.buildEvidenceSummary(evidence, doc);
  assert.equal(container.children.length, 2);
  assert.match(container.children[0].className, /evidence-used/);
  assert.match(container.children[1].className, /evidence-unavailable/);
  assert.equal(container.children[0].textContent, 'kubernetes (3)');
});

test('buildTimeline renders one row per milestone in the given order and escapes malicious content', () => {
  const doc = new FakeDocument();
  const milestones = [
    { type: 'activation', recordedAt: '2024-01-01T00:00:00.000Z', data: { scenarioName: 'OOMKilled', domain: 'Bulk Tank', impactedService: 'tank-monitor' } },
    { type: 'evidence_collected', recordedAt: '2024-01-01T00:00:05.000Z', data: { category: 'kubernetes', toolName: '<script>alert(1)</script>' } },
  ];
  const list = incidentUI.buildTimeline(milestones, doc);
  assert.equal(list.children.length, 2);
  const scriptTags = flatten(list).filter((n) => n.tagName === 'SCRIPT');
  assert.equal(scriptTags.length, 0);
  assert.match(list.children[1].children[2].textContent, /<script>alert\(1\)<\/script>/);
});

test('buildLinks only renders links that pass the safe-URL check, and never fabricates a default link', () => {
  const doc = new FakeDocument();
  const toSafeHttpUrl = (v) => (v && v.startsWith('https://') ? v : null);

  const noneConfigured = incidentUI.buildLinks({ threadUrl: null, analyticsUrl: null }, doc, toSafeHttpUrl);
  assert.equal(noneConfigured.children.length, 0);

  const oneConfigured = incidentUI.buildLinks({ threadUrl: 'https://aka.ms/sreagent/portal/thread/1', analyticsUrl: null }, doc, toSafeHttpUrl);
  assert.equal(oneConfigured.children.length, 1);
  assert.equal(oneConfigured.children[0].getAttribute('href'), 'https://aka.ms/sreagent/portal/thread/1');
  assert.equal(oneConfigured.children[0].getAttribute('rel'), 'noopener noreferrer');

  const unsafeRejected = incidentUI.buildLinks({ threadUrl: 'javascript:alert(1)', analyticsUrl: null }, doc, toSafeHttpUrl);
  assert.equal(unsafeRejected.children.length, 0);
});
