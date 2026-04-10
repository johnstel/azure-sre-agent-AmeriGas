const express = require('express');
const { execFile, spawn } = require('child_process');
const path = require('path');
const util = require('util');
const crypto = require('crypto');
const { CopilotClient, approveAll } = require('@github/copilot-sdk');
const { createTools } = require('./copilot-tools');
const { SYSTEM_PROMPT } = require('./system-prompt');

const execFileAsync = util.promisify(execFile);
const app = express();
const PORT = process.env.PORT || 3000;
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Scenario file mapping
const SCENARIO_MAP = {
  oom: 'oom-killed.yaml',
  crash: 'crash-loop.yaml',
  image: 'image-pull-backoff.yaml',
  cpu: 'high-cpu.yaml',
  pending: 'pending-pods.yaml',
  probe: 'probe-failure.yaml',
  network: 'network-block.yaml',
  config: 'missing-config.yaml',
  mongodb: 'mongodb-down.yaml',
  service: 'service-mismatch.yaml',
};

// --- Operation Tracking (deploy / destroy / validate) ---
const operations = new Map();

function createOperation(type, label) {
  const id = crypto.randomBytes(4).toString('hex');
  const op = { id, type, label, status: 'running', startedAt: new Date().toISOString(), endedAt: null, exitCode: null, log: [], subscribers: new Set(), process: null };
  operations.set(id, op);
  return op;
}

function appendLog(op, stream, text) {
  const entry = { ts: new Date().toISOString(), stream, text };
  op.log.push(entry);
  for (const res of op.subscribers) res.write(`data: ${JSON.stringify(entry)}\n\n`);
}

function finishOperation(op, exitCode) {
  op.status = exitCode === 0 ? 'completed' : 'failed';
  op.exitCode = exitCode;
  op.endedAt = new Date().toISOString();
  op.process = null;
  for (const res of op.subscribers) {
    res.write(`data: ${JSON.stringify({ ts: op.endedAt, stream: 'system', text: `\n── Operation ${op.status} (exit ${exitCode}) ──` })}\n\n`);
    res.write(`event: done\ndata: ${JSON.stringify({ status: op.status, exitCode })}\n\n`);
    res.end();
  }
  op.subscribers.clear();
}

// Middleware
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const IS_WIN = process.platform === 'win32';

function runCommand(cmd, args, opts = {}) {
  if (IS_WIN) return execFileAsync(process.env.ComSpec || 'cmd.exe', ['/c', cmd, ...args], opts);
  return execFileAsync(cmd, args, opts);
}

async function kubectl(...args) {
  try { const { stdout } = await runCommand('kubectl', args, { timeout: 15000 }); return stdout; }
  catch (err) { throw new Error(err.stderr || err.message); }
}

async function az(...args) {
  try { const { stdout } = await runCommand('az', args, { timeout: 30000 }); return stdout; }
  catch (err) { throw new Error(err.stderr || err.message); }
}

function spawnPwsh(op, scriptPath, scriptArgs) {
  const child = spawn('pwsh', ['-NoLogo', '-NoProfile', '-File', scriptPath, ...scriptArgs], {
    cwd: REPO_ROOT, env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  op.process = child;
  child.stdout.on('data', (buf) => appendLog(op, 'stdout', buf.toString()));
  child.stderr.on('data', (buf) => appendLog(op, 'stderr', buf.toString()));
  child.on('error', (err) => { appendLog(op, 'stderr', `Process error: ${err.message}`); finishOperation(op, 1); });
  child.on('close', (code) => finishOperation(op, code ?? 1));
  return op;
}

// --- Kubernetes API Endpoints ---

app.get('/api/pods', async (req, res) => {
  try { res.json(JSON.parse(await kubectl('get', 'pods', '-n', 'propane', '-o', 'json'))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/networkpolicies', async (req, res) => {
  try { res.json(JSON.parse(await kubectl('get', 'networkpolicy', '-n', 'propane', '-o', 'json'))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/endpoints', async (req, res) => {
  try { res.json(JSON.parse(await kubectl('get', 'endpoints', '-n', 'propane', '-o', 'json'))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/services', async (req, res) => {
  try { res.json(JSON.parse(await kubectl('get', 'svc', '-n', 'propane', '-o', 'json'))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/nodes', async (req, res) => {
  try { res.json(JSON.parse(await kubectl('get', 'nodes', '-o', 'json'))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/deployments', async (req, res) => {
  try { res.json(JSON.parse(await kubectl('get', 'deployments', '-n', 'propane', '-o', 'json'))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/events', async (req, res) => {
  try { res.json(JSON.parse(await kubectl('get', 'events', '-n', 'propane', '--sort-by=.lastTimestamp', '-o', 'json'))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/cluster-info', async (req, res) => {
  try {
    const [context, accountRaw, rgRaw] = await Promise.all([
      kubectl('config', 'current-context').then(s => s.trim()).catch(() => 'No cluster'),
      az('account', 'show', '-o', 'json').catch(() => '{}'),
      az('group', 'list', '--tag', 'workload=amerigas-propane-demo', '-o', 'json').catch(() => '[]'),
    ]);
    const account = JSON.parse(accountRaw);
    const rgs = JSON.parse(rgRaw);
    res.json({ context, subscription: account.name || 'Unknown', subscriptionId: account.id || '', resourceGroup: rgs.length > 0 ? rgs[0].name : 'Not found', location: rgs.length > 0 ? rgs[0].location : '' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Break / Fix Endpoints ---

app.post('/api/break/:scenario', async (req, res) => {
  const filename = SCENARIO_MAP[req.params.scenario];
  if (!filename) return res.status(400).json({ error: `Unknown scenario: ${req.params.scenario}` });
  try { const out = await kubectl('apply', '-f', path.resolve(REPO_ROOT, 'k8s', 'scenarios', filename)); res.json({ success: true, message: out.trim() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fix/all', async (req, res) => {
  try { const out = await kubectl('apply', '-f', path.resolve(REPO_ROOT, 'k8s', 'base', 'application.yaml')); res.json({ success: true, message: out.trim() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fix/network', async (req, res) => {
  try { const out = await kubectl('delete', 'networkpolicy', 'deny-tank-monitor', '-n', 'propane', '--ignore-not-found'); res.json({ success: true, message: out.trim() || 'Network policy removed' }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fix/extras', async (req, res) => {
  try { const out = await kubectl('delete', 'deployment', 'demand-forecast-overload', 'fleet-telemetry-monitor', 'safety-compliance-monitor', 'delivery-zone-config', '-n', 'propane', '--ignore-not-found'); res.json({ success: true, message: out.trim() || 'Extra deployments removed' }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Long-Running Operations ---

app.get('/api/operations', (req, res) => {
  const list = [];
  for (const op of operations.values()) list.push({ id: op.id, type: op.type, label: op.label, status: op.status, startedAt: op.startedAt, endedAt: op.endedAt, exitCode: op.exitCode });
  res.json(list.reverse());
});

app.get('/api/operations/:id/stream', (req, res) => {
  const op = operations.get(req.params.id);
  if (!op) return res.status(404).json({ error: 'Operation not found' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  for (const entry of op.log) res.write(`data: ${JSON.stringify(entry)}\n\n`);
  if (op.status !== 'running') { res.write(`event: done\ndata: ${JSON.stringify({ status: op.status, exitCode: op.exitCode })}\n\n`); return res.end(); }
  op.subscribers.add(res);
  req.on('close', () => op.subscribers.delete(res));
});

app.delete('/api/operations/:id', (req, res) => {
  const op = operations.get(req.params.id);
  if (!op) return res.status(404).json({ error: 'Operation not found' });
  if (op.status !== 'running') return res.json({ message: 'Already finished' });
  if (op.process) { op.process.kill('SIGTERM'); appendLog(op, 'system', '\n── Cancelled by user ──'); }
  op.status = 'cancelled'; op.endedAt = new Date().toISOString();
  for (const r of op.subscribers) { r.write(`event: done\ndata: ${JSON.stringify({ status: 'cancelled', exitCode: null })}\n\n`); r.end(); }
  op.subscribers.clear();
  res.json({ message: 'Cancelled' });
});

app.post('/api/deploy', (req, res) => {
  for (const op of operations.values()) { if (op.status === 'running' && (op.type === 'deploy' || op.type === 'destroy')) return res.status(409).json({ error: `A ${op.type} operation is already running (${op.id})` }); }
  const { location = 'eastus2', workloadName = 'srelab', skipRbac = false, skipSreAgent = false } = req.body || {};
  if (!['eastus2', 'swedencentral', 'australiaeast'].includes(location)) return res.status(400).json({ error: `Location must be one of: eastus2, swedencentral, australiaeast` });
  const op = createOperation('deploy', `Deploy to ${location}`);
  appendLog(op, 'system', `🚀 Starting deployment: ${location} / ${workloadName}`);
  const args = ['-Location', location, '-WorkloadName', workloadName, '-Yes'];
  if (skipRbac) args.push('-SkipRbac');
  if (skipSreAgent) args.push('-SkipSreAgent');
  spawnPwsh(op, path.resolve(REPO_ROOT, 'scripts', 'deploy.ps1'), args);
  res.json({ id: op.id, type: op.type, label: op.label });
});

app.post('/api/destroy', (req, res) => {
  for (const op of operations.values()) { if (op.status === 'running' && (op.type === 'deploy' || op.type === 'destroy')) return res.status(409).json({ error: `A ${op.type} operation is already running (${op.id})` }); }
  const { resourceGroupName = 'rg-srelab-eastus2' } = req.body || {};
  const op = createOperation('destroy', `Destroy ${resourceGroupName}`);
  appendLog(op, 'system', `🗑️  Destroying: ${resourceGroupName}`);
  spawnPwsh(op, path.resolve(REPO_ROOT, 'scripts', 'destroy.ps1'), ['-ResourceGroupName', resourceGroupName, '-Force']);
  res.json({ id: op.id, type: op.type, label: op.label });
});

app.post('/api/validate', (req, res) => {
  const { resourceGroupName = 'rg-srelab-eastus2' } = req.body || {};
  const op = createOperation('validate', `Validate ${resourceGroupName}`);
  appendLog(op, 'system', `🔍 Validating deployment: ${resourceGroupName}`);
  spawnPwsh(op, path.resolve(REPO_ROOT, 'scripts', 'validate-deployment.ps1'), ['-ResourceGroupName', resourceGroupName, '-Detailed']);
  res.json({ id: op.id, type: op.type, label: op.label });
});

app.get('/api/pods/:name/logs', async (req, res) => {
  try { const out = await kubectl('logs', req.params.name, '-n', 'propane', '--tail=80'); res.json({ logs: out }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Copilot SDK Integration ---
let copilotClient = null;
let copilotSession = null;
let copilotReady = false;
let copilotError = null;
let chatHistory = [];

app.get('/api/copilot/status', (req, res) => {
  res.json({ ready: copilotReady, error: copilotError, sessionId: copilotSession?.sessionId || null });
});

app.post('/api/chat', async (req, res) => {
  if (!copilotReady || !copilotSession) return res.status(503).json({ error: copilotError || 'Copilot not initialized' });
  const { message } = req.body;
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message is required' });

  chatHistory.push({ role: 'user', content: message, timestamp: new Date().toISOString() });

  try {
    const response = await copilotSession.sendAndWait({ prompt: message }, 120000);
    const content = response?.data?.content || '(no response)';
    const toolRequests = response?.data?.toolRequests || [];
    chatHistory.push({ role: 'assistant', content, toolRequests, timestamp: new Date().toISOString() });
    res.json({ content, toolRequests });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/chat/history', (req, res) => { res.json(chatHistory); });

app.post('/api/chat/reset', async (req, res) => {
  try {
    if (copilotSession) await copilotSession.disconnect();
    const tools = createTools();
    copilotSession = await copilotClient.createSession({
      onPermissionRequest: approveAll, clientName: 'amerigas-mission-control',
      systemMessage: { mode: 'append', content: SYSTEM_PROMPT },
      tools, availableTools: tools.map(t => t.name),
    });
    chatHistory = [];
    res.json({ success: true, sessionId: copilotSession.sessionId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Startup ---
async function preflight() {
  const checks = [];
  try { await runCommand('kubectl', ['version', '--client', '--short'], { timeout: 15000 }); checks.push('  ✅ kubectl available'); }
  catch { checks.push('  ⚠️  kubectl not found — cluster features will fail'); }
  try { await runCommand('az', ['version', '-o', 'none'], { timeout: 15000 }); checks.push('  ✅ az CLI available'); }
  catch { checks.push('  ⚠️  az CLI not found — Azure info will be unavailable'); }
  return checks;
}

(async () => {
  console.log('');
  console.log('  🔥 AmeriGas Propane — Mission Control');
  console.log('  ─────────────────────────────────────');
  console.log('  Powered by GitHub Copilot SDK');
  console.log('');
  const checks = await preflight();
  checks.forEach(c => console.log(c));

  console.log('  ⏳ Initializing Copilot SDK...');
  try {
    copilotClient = new CopilotClient({ logLevel: 'error' });
    await copilotClient.start();
    const tools = createTools();
    copilotSession = await copilotClient.createSession({
      onPermissionRequest: approveAll, clientName: 'amerigas-mission-control',
      systemMessage: { mode: 'append', content: SYSTEM_PROMPT },
      tools, availableTools: tools.map(t => t.name),
    });
    copilotReady = true;
    console.log('  ✅ Copilot SDK initialized');
  } catch (err) {
    copilotError = err.message;
    console.log(`  ⚠️  Copilot SDK failed: ${err.message}`);
  }

  app.listen(PORT, () => {
    console.log('');
    console.log(`  🚀 Dashboard → http://localhost:${PORT}`);
    console.log('');
  });
})();
