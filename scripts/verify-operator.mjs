import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourcePath = join(root, 'mock-api', 'db.json');
const original = await readFile(sourcePath, 'utf8');
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'hydroguard-operator-'));
const databasePath = join(temporaryDirectory, 'db.json');
await writeFile(databasePath, original);
const child = spawn(process.execPath, [join(root, 'mock-api', 'server.mjs')], {
  cwd: root,
  env: { ...process.env, PORT: '0', MOCK_DB_PATH: databasePath },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let checks = 0;
try {
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('El mock no inició a tiempo.')), 10000);
    child.stdout.on('data', (buffer) => {
      const match = buffer.toString().match(/http:\/\/127\.0\.0\.1:(\d+)\/api\/v1/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    child.once('error', reject);
  });
  const request = async (method, path, token, body, expected = 200) => {
    const response = await fetch(baseUrl + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = response.status === 204 ? undefined : await response.json();
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result)}`);
    checks++;
    return result;
  };
  const admin = await request('POST', '/authentication/sign-in', null, { identifier: 'admin.hidro@hydroguard.pe', password: 'adminpassword123' });
  await request('GET', '/operator/context', admin.token, undefined, 403);
  await request('POST', '/authentication/sign-in', null, { identifier: 'carlos.mendoza', password: 'operadorpassword123' }, 403);
  const first = await request('POST', '/authentication/operator-first-access', null, { identifier: 'carlos.mendoza', password: 'operadorpassword123', code: 'HG-31Z8P9' });
  await request('POST', '/authentication/operator-first-access', null, { identifier: 'carlos.mendoza', password: 'operadorpassword123', code: 'HG-31Z8P9' }, 422);
  const context = await request('GET', '/operator/context', first.token);
  assert.equal(context.assignments.length, 1);
  assert.equal(context.assignments[0].deviceId, 'dev-202');
  await request('GET', '/operator/devices/dev-101/telemetry', first.token, undefined, 403);
  const telemetry = await request('GET', '/operator/devices/dev-202/telemetry', first.token);
  assert.ok(telemetry.latest);
  const configuration = { phMin: 5.5, phMax: 6.5, temperatureMin: 18, temperatureMax: 25, correctionAction: 'Representar corrección con LED', waitingMinutes: 10, maximumCycles: 2, releaseMode: 'MANUAL' };
  await request('PUT', '/operator/assignments/asgn-4/configuration', first.token, configuration);
  await request('POST', '/operator/assignments/asgn-4/configuration/publish', first.token, {});
  const treatments = await request('GET', '/operator/treatments', first.token);
  const pending = treatments.find((item) => item.state === 'PENDING_CORRECTION_APPROVAL');
  assert.ok(pending.allowedActions.includes('APPROVE_STRATEGY'));
  const approved = await request('POST', `/operator/treatments/${pending.id}/commands`, first.token, { command: 'APPROVE_STRATEGY' });
  assert.equal(approved.state, 'CORRECTING');
  const alerts = await request('GET', '/operator/alerts', first.token);
  const active = alerts.find((item) => item.status === 'ACTIVE');
  const acknowledged = await request('PATCH', `/operator/alerts/${active.id}/acknowledge`, first.token, {});
  assert.equal(acknowledged.status, 'ACKNOWLEDGED');
  await request('GET', '/operator/devices/dev-202/history', first.token);
  assert.equal(await readFile(sourcePath, 'utf8'), original);
  console.log(`Operador: ${checks} comprobaciones HTTP aprobadas; rol, alcance, configuración, telemetría, Treatment y Monitoring verificados.`);
} finally {
  if (child.exitCode === null) {
    const exited = once(child, 'exit'); child.kill(); await Promise.race([exited, delay(5000)]);
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
}
