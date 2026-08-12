const test = require('node:test');
const assert = require('node:assert/strict');
const renderUtils = require('../public/render-utils');

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.style = {};
    this.className = '';
    this.textContent = '';
    this.listeners = {};
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name];
  }

  addEventListener(type, handler) {
    this.listeners[type] = handler;
  }
}

class FakeDocument {
  createElement(tagName) {
    return new FakeElement(tagName);
  }

  createTextNode(text) {
    const node = new FakeElement('#text');
    node.textContent = String(text);
    return node;
  }
}

test('pod rows keep malicious pod names as text content', () => {
  const doc = new FakeDocument();
  const row = renderUtils.buildPodRow({ name: '<img src=x onerror=alert(1)>', status: 'Running', ready: '1/1', restarts: 0, age: '2024-01-01' }, () => '1m', null, doc);
  const link = row.children[0].children[0];

  assert.equal(link.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(link.tagName, 'A');
  assert.equal(row.children.filter(child => child.tagName === 'IMG').length, 0);
});

test('event rows keep malicious messages as text content', () => {
  const doc = new FakeDocument();
  const row = renderUtils.buildEventRow({
    type: 'Warning',
    lastTimestamp: '2024-01-01T00:00:00Z',
    involvedObject: { name: '<svg/onload=alert(1)>' },
    message: '<script>alert(1)</script>'
  }, () => '2m', doc);

  const messageNode = row.children[2];
  assert.equal(messageNode.textContent, '<svg/onload=alert(1)>: <script>alert(1)</script>');
  assert.equal(row.children.filter(child => child.tagName === 'SCRIPT').length, 0);
});

test('portal links reject javascript URLs', () => {
  const doc = new FakeDocument();
  const link = renderUtils.buildPortalLink({ status: { loadBalancer: { ingress: [{ hostname: 'javascript:alert(1)' }] } } }, doc);

  assert.equal(link.textContent, 'javascript:alert(1) ↗');
  assert.equal(link.getAttribute('href'), undefined);
});

test('chat messages render malicious error text as plain text', () => {
  const doc = new FakeDocument();
  const message = renderUtils.buildChatMessage('assistant', '<img src=x onerror=alert(1)> Error: <script>alert(1)</script>', doc);

  assert.equal(message.textContent, '<img src=x onerror=alert(1)> Error: <script>alert(1)</script>');
  assert.equal(message.children.filter(child => child.tagName === 'IMG').length, 0);
  assert.equal(message.children.filter(child => child.tagName === 'SCRIPT').length, 0);
});
