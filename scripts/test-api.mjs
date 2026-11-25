import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';

const database = await MongoMemoryReplSet.create({ binary: { downloadDir: new URL('../.mongo-binaries/', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1') }, replSet: { count: 1 } });
const origin = 'http://localhost:5417';
const password = 'IntegrationOnly-NotARealPassword123!';
const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env: { ...process.env, NODE_ENV: 'test', MONGODB_URI: database.getUri(), MONGODB_DATABASE: 'haya', APP_ORIGIN: origin, PORT: '5417', SEED_DEMO: 'true', LOCAL_ADMIN_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOutput = ''; child.stdout.on('data', b => { serverOutput += b; }); child.stderr.on('data', b => { serverOutput += b; });
async function request(route, { cookie = '', method = 'GET', body, expected = 200, requestOrigin = origin } = {}) {
  const response = await fetch(origin + '/api' + route, { method, headers: { Origin: requestOrigin, Cookie: cookie, ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }, body: body ? body instanceof FormData ? body : JSON.stringify(body) : undefined });
  const json = await response.json(); assert.equal(response.status, expected, `${route}: ${JSON.stringify(json)}`); return { json, cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
}
async function login(email) { return (await request('/auth/login', { method: 'POST', body: { email, password } })).cookie; }
async function action(cookie, action, expected = 200) { return (await request('/actions', { cookie, method: 'POST', body: { action }, expected })).json; }
try {
  for (let i = 0; i < 80; i++) { if (child.exitCode !== null) throw new Error(serverOutput); try { const response = await fetch(origin + '/api/health'); if (response.ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 250)); }
  await request('/workspace', { expected: 401 });
  await request('/auth/login', { method: 'POST', body: { email: 'owner@haya.demo', password }, expected: 403, requestOrigin: 'http://malicious.example' });
  const supervisor = await login('supervisor@haya.demo'); const manager = await login('manager@haya.demo'); const owner = await login('owner@haya.demo'); const client = await login('client@haya.demo');
  let workspace = (await request('/workspace', { cookie: supervisor })).json;
  assert.equal(workspace.data.sites.length, 2); assert.ok(workspace.people.every(p => !p.passwordHash));
  const task = workspace.data.sites[0].tasks[45];
  const form = new FormData(); form.append('siteId', 'site-1'); form.append('photo', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yC1sAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'evidence.png');
  const photo = (await request('/media', { cookie: supervisor, method: 'POST', body: form, expected: 201 })).json;
  const update = { type: 'submitWork', id: 'api-concurrent-work', siteId: 'site-1', taskId: task.id, quantity: 4, remarks: 'API verified work', evidence: [photo.id] };
  await action(supervisor, update); await action(supervisor, update);
  await action(supervisor, { type: 'reviewWork', id: update.id, decision: 'Approved', reason: '' }, 422);
  await Promise.all(Array.from({ length: 6 }, () => action(manager, { type: 'reviewWork', id: update.id, decision: 'Approved', reason: '' })));
  workspace = (await request('/workspace', { cookie: owner })).json;
  assert.equal(workspace.data.ledger.filter(l => l.sourceId === update.id).length, 1); assert.equal(workspace.data.sites[0].tasks[45].approved, 4);
  await action(supervisor, { ...update, id: 'unauthorised-site', siteId: 'site-3' }, 403);
  await action(supervisor, { ...update, id: 'forged-author', authorId: 'owner' }, 422);
  await action(client, { type: 'verifyResource', id: 'MT-021' }, 422);
  const clientData = (await request('/workspace', { cookie: client })).json.data;
  for (const key of ['visits', 'resources', 'audit', 'reports', 'work', 'defects', 'ledger']) assert.equal(clientData[key].length, 0);
  await request(`/media/${photo.id}`, { cookie: client, expected: 404 });
  const photoUrl = (await request(`/media/${photo.id}`, { cookie: manager })).json.url;
  const photoResponse = await fetch(origin + photoUrl, { headers: { Cookie: manager } }); assert.equal(photoResponse.status, 200); assert.equal(photoResponse.headers.get('content-type'), 'image/png');
  await action(supervisor, { type: 'submitReport', id: 'daily-api', siteId: 'site-1', date: '2026-11-17', summary: 'Foundation records complete', tomorrow: 'Continue the next stage', blockers: '', labour: 12, hours: 8 });
  await action(manager, { type: 'reviewReport', id: 'daily-api', decision: 'Approved', reason: '' });
  await action(manager, { type: 'defectAction', id: 'DF-012', decision: 'verify', reason: '' });
  await action(supervisor, { type: 'defectAction', id: 'DF-012', decision: 'correct', reason: 'Surface corrected', evidence: [photo.id] });
  await action(manager, { type: 'defectAction', id: 'DF-012', decision: 'close', reason: 'Measured and accepted' });
  await action(manager, { type: 'checkIn', id: 'manager-visit', siteId: 'site-1', location: null, reason: 'Boundary not configured' });
  await action(manager, { type: 'checkOut', id: 'manager-visit', location: null, reason: 'Visit complete' });
  await action(owner, { type: 'reviewVisit', id: 'manager-visit', decision: 'Accepted' });
  await request('/users', { cookie: supervisor, method: 'POST', body: { name: 'Blocked', email: 'blocked@example.com', role: 'Owner', siteIds: [] }, expected: 403 });
  const invite = await request('/users', { cookie: owner, method: 'POST', body: { name: 'New Supervisor', email: 'new@example.com', role: 'Supervisor', siteIds: ['site-2'] }, expected: 201 });
  assert.ok(invite.json.temporaryPassword); const account = await request('/auth/login', { method: 'POST', body: { email: 'new@example.com', password: invite.json.temporaryPassword } });
  const assigned = (await request('/workspace', { cookie: account.cookie })).json; assert.deepEqual(assigned.data.sites.map(s => s.id), ['site-2']);
  await request('/auth/logout', { cookie: supervisor, method: 'POST', body: {} }); await request('/workspace', { cookie: supervisor, expected: 401 });
  console.log('PASS: real MongoDB replica-set API integration, sessions, origin checks, scoped access, photo storage, concurrent idempotent approvals, reports, defects, attendance, account creation and logout.');
} finally {
  child.kill('SIGTERM'); if (child.exitCode === null) await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
  await database.stop();
}
