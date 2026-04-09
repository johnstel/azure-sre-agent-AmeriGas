const express = require('express');
const { execFile } = require('child_process');
const path = require('path');
const util = require('util');

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

// Middleware
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// Helper to run kubectl commands
async function kubectl(...args) {
  try {
    const { stdout } = await execFileAsync('kubectl', args, { timeout: 15000 });
    return stdout;
  } catch (err) {
    throw new Error(err.stderr || err.message);
  }
}

// Helper to run az commands
async function az(...args) {
  try {
    const { stdout } = await execFileAsync('az', args, { timeout: 15000 });
    return stdout;
  } catch (err) {
    throw new Error(err.stderr || err.message);
  }
}

// --- API Endpoints ---

app.get('/api/pods', async (req, res) => {
  try {
    const out = await kubectl('get', 'pods', '-n', 'propane', '-o', 'json');
    res.json(JSON.parse(out));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/services', async (req, res) => {
  try {
    const out = await kubectl('get', 'svc', '-n', 'propane', '-o', 'json');
    res.json(JSON.parse(out));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/nodes', async (req, res) => {
  try {
    const out = await kubectl('get', 'nodes', '-o', 'json');
    res.json(JSON.parse(out));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/deployments', async (req, res) => {
  try {
    const out = await kubectl('get', 'deployments', '-n', 'propane', '-o', 'json');
    res.json(JSON.parse(out));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/events', async (req, res) => {
  try {
    const out = await kubectl('get', 'events', '-n', 'propane',
      '--sort-by=.lastTimestamp', '-o', 'json');
    res.json(JSON.parse(out));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cluster-info', async (req, res) => {
  try {
    const [context, accountRaw, rgRaw] = await Promise.all([
      kubectl('config', 'current-context').then(s => s.trim()),
      az('account', 'show', '-o', 'json').catch(() => '{}'),
      az('group', 'list', '--tag', 'workload=amerigas-propane-demo', '-o', 'json').catch(() => '[]'),
    ]);
    const account = JSON.parse(accountRaw);
    const rgs = JSON.parse(rgRaw);
    res.json({
      context,
      subscription: account.name || 'Unknown',
      subscriptionId: account.id || '',
      resourceGroup: rgs.length > 0 ? rgs[0].name : 'Not found',
      location: rgs.length > 0 ? rgs[0].location : '',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/break/:scenario', async (req, res) => {
  const scenario = req.params.scenario;
  const filename = SCENARIO_MAP[scenario];
  if (!filename) {
    return res.status(400).json({ error: `Unknown scenario: ${scenario}` });
  }
  const yamlPath = path.resolve(REPO_ROOT, 'k8s', 'scenarios', filename);
  try {
    const out = await kubectl('apply', '-f', yamlPath);
    res.json({ success: true, message: out.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/fix/all', async (req, res) => {
  const yamlPath = path.resolve(REPO_ROOT, 'k8s', 'base', 'application.yaml');
  try {
    const out = await kubectl('apply', '-f', yamlPath);
    res.json({ success: true, message: out.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/fix/network', async (req, res) => {
  try {
    const out = await kubectl('delete', 'networkpolicy', 'deny-tank-monitor',
      '-n', 'propane', '--ignore-not-found');
    res.json({ success: true, message: out.trim() || 'Network policy removed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/fix/extras', async (req, res) => {
  try {
    const out = await kubectl('delete', 'deployment',
      'demand-forecast-overload', 'fleet-telemetry-monitor',
      'safety-compliance-monitor', 'delivery-zone-config',
      '-n', 'propane', '--ignore-not-found');
    res.json({ success: true, message: out.trim() || 'Extra deployments removed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Startup checks
async function preflight() {
  const checks = [];
  try {
    await execFileAsync('kubectl', ['version', '--client', '--short'], { timeout: 5000 });
    checks.push('  ✅ kubectl available');
  } catch {
    checks.push('  ⚠️  kubectl not found — cluster features will fail');
  }
  try {
    await execFileAsync('az', ['version', '-o', 'none'], { timeout: 5000 });
    checks.push('  ✅ az CLI available');
  } catch {
    checks.push('  ⚠️  az CLI not found — Azure info will be unavailable');
  }
  return checks;
}

(async () => {
  console.log('');
  console.log('  🔥 AmeriGas Propane — Mission Control');
  console.log('  ─────────────────────────────────────');
  const checks = await preflight();
  checks.forEach(c => console.log(c));
  console.log('');

  app.listen(PORT, () => {
    console.log(`  🚀 Dashboard → http://localhost:${PORT}`);
    console.log('');
  });
})();
