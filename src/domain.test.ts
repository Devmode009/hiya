import { describe, it, expect } from 'vitest';
import { applyAction, demoUsers, seedData, siteStats, templateTasks, visibleData, type Action } from './domain';
const [owner, manager, supervisor, client] = demoUsers;
describe('source template and independent ledgers', () => {
  it('preserves all 74 checks and exact stage allocations', () => {
    const tasks = templateTasks(); expect(tasks).toHaveLength(74); expect(new Set(tasks.map(t => t.id)).size).toBe(74); expect(tasks.every(t => t.mandatory)).toBe(true);
    for (const [stage, points] of Object.entries({ 'Civil work': 400, 'DC work': 200, 'AC work': 150, 'MMS & modules': 250 })) expect(tasks.filter(t => t.stage === stage).reduce((sum, t) => sum + Math.round(t.points * 100), 0)).toBe(points * 100);
  });
  it('credits cumulative approved work exactly once without touching quality', () => {
    let data = seedData(); const site = data.sites[0]; const task = site.tasks[40]; const before = siteStats(data, site);
    data = applyAction(data, supervisor, { type: 'submitWork', id: 'wu-test', siteId: site.id, taskId: task.id, quantity: 4, remarks: 'Four units completed', evidence: [] });
    expect(siteStats(data, data.sites[0]).balance).toBe(before.balance);
    expect(() => applyAction(data, supervisor, { type: 'reviewWork', id: 'wu-test', decision: 'Approved', reason: '' })).toThrow();
    data = applyAction(data, manager, { type: 'reviewWork', id: 'wu-test', decision: 'Approved', reason: '' });
    const after = siteStats(data, data.sites[0]); expect(after.balance).toBeLessThan(before.balance); expect(after.quality).toBe(before.quality);
    const retry = applyAction(data, manager, { type: 'reviewWork', id: 'wu-test', decision: 'Approved', reason: '' }); expect(retry).toBe(data); expect(data.ledger.filter(l => l.sourceId === 'wu-test')).toHaveLength(1);
  });
  it('cumulative rounding never overcredits a task', () => {
    let data = seedData(); const task = data.sites[0].tasks[45];
    for (let i = 0; i < 20; i++) { data = applyAction(data, supervisor, { type: 'submitWork', id: `partial-${i}`, siteId: 'site-1', taskId: task.id, quantity: 1, remarks: 'One additional unit', evidence: [] }); data = applyAction(data, manager, { type: 'reviewWork', id: `partial-${i}`, decision: 'Approved', reason: '' }); }
    expect(data.ledger.filter(l => l.sourceId.startsWith('partial-')).reduce((a, l) => a + l.amount, 0)).toBe(Math.round(task.points * 100));
    expect(() => applyAction(data, supervisor, { type: 'submitWork', id: 'excess', siteId: 'site-1', taskId: task.id, quantity: 1, remarks: 'Excess', evidence: [] })).toThrow('exceeds');
  });
  it('blocks overcommitment including pending quantities and duplicate submissions', () => {
    let data = seedData(); const action: Action = { type: 'submitWork', id: 'stable-request', siteId: 'site-1', taskId: data.sites[0].tasks[45].id, quantity: 15, remarks: 'Done', evidence: [] };
    data = applyAction(data, supervisor, action); expect(applyAction(data, supervisor, action)).toBe(data);
    expect(() => applyAction(data, supervisor, { ...action, id: 'different-request', quantity: 6 })).toThrow('exceeds');
  });
  it('only verified quality issues deduct points; closing does not restore them', () => {
    let data = seedData(); const balance = siteStats(data, data.sites[0]).balance;
    data = applyAction(data, manager, { type: 'defectAction', id: 'DF-012', decision: 'verify', reason: '' }); expect(siteStats(data, data.sites[0]).quality).toBe(97);
    expect(applyAction(data, manager, { type: 'defectAction', id: 'DF-012', decision: 'verify', reason: '' })).toBe(data);
    expect(() => applyAction(data, supervisor, { type: 'defectAction', id: 'DF-012', decision: 'correct', reason: 'Fixed', evidence: [] })).toThrow('photo');
    data = applyAction(data, supervisor, { type: 'defectAction', id: 'DF-012', decision: 'correct', reason: 'Corrected finish', evidence: ['photo-1'] });
    data = applyAction(data, manager, { type: 'defectAction', id: 'DF-012', decision: 'close', reason: 'Reinspected against drawing' });
    expect(siteStats(data, data.sites[0])).toMatchObject({ quality: 97, balance });
  });
});
describe('role scope and record integrity', () => {
  it('rejects unassigned sites, client writes, self review and bill duplicates', () => {
    const data = seedData();
    expect(() => applyAction(data, supervisor, { type: 'checkIn', id: 'v', siteId: 'site-3', location: null, reason: 'Visit' })).toThrow('not assigned');
    expect(() => applyAction(data, client, { type: 'verifyResource', id: 'MT-021' })).toThrow('read-only');
    expect(() => applyAction(data, supervisor, { type: 'verifyResource', id: 'MT-021' })).toThrow();
    expect(() => applyAction(data, manager, { type: 'addResource', id: 'duplicate', siteId: 'site-1', kind: 'Material', name: 'Cement', quantity: 10, unit: 'bags', reference: ' inv-2041 ', supplier: 'southern building supplies', rate: 420 })).toThrow('already recorded');
  });
  it('client views exclude internal records and staff locations', () => {
    const data = visibleData(seedData(), client); expect(data.resources).toEqual([]); expect(data.work).toEqual([]); expect(data.visits).toEqual([]); expect(data.audit).toEqual([]); expect(data.sites).toHaveLength(2);
    expect(siteStats(data, data.sites[0]).progress).toBeGreaterThan(0);
  });
  it('one open visit at a time and independent review after checkout', () => {
    let data = seedData(); data = applyAction(data, supervisor, { type: 'checkIn', id: 'visit-a', siteId: 'site-1', location: null, reason: 'GPS unavailable' });
    expect(() => applyAction(data, supervisor, { type: 'checkIn', id: 'visit-b', siteId: 'site-2', location: null, reason: 'New site' })).toThrow('Check out');
    expect(() => applyAction(data, manager, { type: 'reviewVisit', id: 'visit-a', decision: 'Accepted' })).toThrow('checked out');
    data = applyAction(data, supervisor, { type: 'checkOut', id: 'visit-a', location: null, reason: 'Finished visit' }); data = applyAction(data, manager, { type: 'reviewVisit', id: 'visit-a', decision: 'Accepted' });
    expect(data.visits[0].status).toBe('Accepted'); expect(data.ledger.length).toBe(seedData().ledger.length);
  });
  it('new projects snapshot 74 activities and do not alter other sites', () => {
    const data = seedData(); const next = applyAction(data, owner, { type: 'createProject', id: 'new-project', name: 'Test solar', client: 'Client', location: 'Madurai', due: '2027-12-01', siteName: 'New field', capacity: '5 MW' });
    expect(next.sites[0].tasks).toHaveLength(74); expect(next.sites[0].tasks.every(t => t.approved === 0)).toBe(true); expect(next.sites[1]).toEqual(data.sites[0]);
  });
  it('manager attendance needs owner review and critical defects block work approval', () => {
    let data = seedData();
    data = applyAction(data, manager, { type: 'checkIn', id: 'manager-visit', siteId: 'site-1', location: null, reason: 'Boundary not configured' });
    data = applyAction(data, manager, { type: 'checkOut', id: 'manager-visit', location: null, reason: 'Finished visit' });
    expect(() => applyAction(data, { ...manager, id: 'peer-manager' }, { type: 'reviewVisit', id: 'manager-visit', decision: 'Accepted' })).toThrow('owner review');
    data = applyAction(data, owner, { type: 'reviewVisit', id: 'manager-visit', decision: 'Accepted' });
    data = applyAction(data, supervisor, { type: 'addDefect', id: 'critical', siteId: 'site-1', title: 'Critical hold', detail: 'Engineering stop', severity: 'Critical', assignee: 'Engineer', due: '2027-01-01' });
    data = applyAction(data, manager, { type: 'defectAction', id: 'critical', decision: 'verify', reason: '' });
    expect(() => applyAction(data, manager, { type: 'reviewWork', id: 'WU-084', decision: 'Approved', reason: '' })).toThrow('critical defect');
  });
});
