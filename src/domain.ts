import template from './site-template.json';

export type Role = 'Owner' | 'Manager' | 'Supervisor' | 'Client';
export type User = { id: string; name: string; email: string; role: Role; siteIds: string[]; organisationId: string };
export type Task = { id: string; name: string; stage: string; group: string; planned: number; unit: string; points: number; approved: number; mandatory: boolean };
export type Site = { id: string; projectId: string; name: string; location: string; capacity: string; due: string; allocation: number; tasks: Task[]; templateVersion: string; centre: { lat: number; lng: number } | null };
export type Project = { id: string; name: string; client: string; location: string; due: string };
export type Work = { id: string; siteId: string; taskId: string; authorId: string; quantity: number; remarks: string; evidence: string[]; status: 'Submitted' | 'Approved' | 'Changes requested'; createdAt: string; reviewReason?: string; reviewerId?: string };
export type Defect = { id: string; siteId: string; title: string; detail: string; severity: 'Low' | 'Medium' | 'High' | 'Critical'; status: 'Reported' | 'Verified' | 'Awaiting reinspection' | 'Closed' | 'Reopened'; authorId: string; assignee: string; due: string; verified: boolean; correction?: string; evidence?: string[] };
export type Resource = { id: string; siteId: string; kind: 'Material' | 'Machinery' | 'Diesel'; name: string; quantity: number; unit: string; reference: string; supplier: string; rate: number; authorId: string; status: 'Pending' | 'Verified'; createdAt: string };
export type Report = { id: string; siteId: string; date: string; summary: string; tomorrow: string; blockers: string; labour: number; hours: number; authorId: string; status: 'Submitted' | 'Approved' | 'Changes requested'; createdAt: string; reviewerId?: string; reviewReason?: string };
export type Location = { lat: number; lng: number; accuracy: number; capturedAt: string };
export type Visit = { id: string; siteId: string; authorId: string; authorRole: Role; inAt: string; outAt?: string; inLocation: Location | null; outLocation?: Location | null; reason: string; status: 'Pending review' | 'Accepted' | 'Rejected'; reviewerId?: string };
export type Ledger = { id: string; siteId: string; sourceId: string; type: 'Work' | 'Quality'; amount: number; createdAt: string; actorId: string };
export type Audit = { id: string; actorId: string; action: string; siteId?: string; createdAt: string };
export type AppData = { projects: Project[]; sites: Site[]; work: Work[]; defects: Defect[]; resources: Resource[]; reports: Report[]; visits: Visit[]; ledger: Ledger[]; audit: Audit[]; revision: number };
export const stages = template.stages.map(s => s.name);
export const penalties = { Low: 1, Medium: 3, High: 5, Critical: 10 };
export const id = () => crypto.randomUUID();
export const today = () => new Date().toLocaleDateString('en-CA');
export const demoUsers: User[] = [
  { id: 'owner', name: 'Priya Sharma', email: 'owner@haya.demo', role: 'Owner', siteIds: [], organisationId: 'haya' },
  { id: 'manager', name: 'Arjun Kumar', email: 'manager@haya.demo', role: 'Manager', siteIds: ['site-1', 'site-2', 'site-3'], organisationId: 'haya' },
  { id: 'supervisor', name: 'Ravi Kumar', email: 'supervisor@haya.demo', role: 'Supervisor', siteIds: ['site-1', 'site-2'], organisationId: 'haya' },
  { id: 'client', name: 'Meera Patel', email: 'client@haya.demo', role: 'Client', siteIds: ['site-1', 'site-2'], organisationId: 'haya' },
];

export function templateTasks(): Task[] {
  return template.stages.flatMap(stage => {
    const count = stage.children.reduce((n, g) => n + g.tasks.length, 0);
    const allocation = (template.points.work.stageWeights as Record<string, number>)[stage.name];
    let index = 0;
    return stage.children.flatMap(group => group.tasks.map(t => {
      // Distribute hundredths once so all task weights sum exactly to the stage allocation.
      const base = Math.floor(allocation * 100 / count);
      const points = (base + (index++ < allocation * 100 - base * count ? 1 : 0)) / 100;
      return { id: t.id, name: t.name, stage: stage.name, group: group.name, planned: 20, unit: 'units', points, approved: 0, mandatory: t.mandatory };
    }));
  });
}
export function seedData(sample = true): AppData {
  const tasks = templateTasks();
  const at = new Date().toISOString();
  const sites: Site[] = sample ? [
    { id: 'site-1', projectId: 'project-1', name: 'North field', location: 'Tirunelveli, Tamil Nadu', capacity: '5 MW', due: '2027-02-28', allocation: 1000, tasks: structuredClone(tasks), templateVersion: '1.0-draft', centre: null },
    { id: 'site-2', projectId: 'project-1', name: 'South field', location: 'Tirunelveli, Tamil Nadu', capacity: '3 MW', due: '2027-03-20', allocation: 1000, tasks: structuredClone(tasks), templateVersion: '1.0-draft', centre: null },
    { id: 'site-3', projectId: 'project-2', name: 'East block', location: 'Coimbatore, Tamil Nadu', capacity: '2 MW', due: '2027-04-15', allocation: 1000, tasks: structuredClone(tasks), templateVersion: '1.0-draft', centre: null },
  ] : [];
  const ledger: Ledger[] = [];
  if (sample) sites.forEach((site, si) => site.tasks.forEach((task, i) => {
    if (i < [28, 16, 8][si]) {
      task.approved = task.planned;
      ledger.push({ id: `initial-${site.id}-${i}`, siteId: site.id, sourceId: `sample-${i}`, type: 'Work', amount: Math.round(task.points * 100), createdAt: at, actorId: 'manager' });
    }
  }));
  return {
    revision: 0, projects: sample ? [
      { id: 'project-1', name: 'Tamirabarani Solar Park', client: 'Sunrise Energy', location: 'Tirunelveli, Tamil Nadu', due: '2027-03-20' },
      { id: 'project-2', name: 'Kovai Green Energy', client: 'Kovai Renewables', location: 'Coimbatore, Tamil Nadu', due: '2027-04-15' },
    ] : [], sites, ledger, work: sample ? [{ id: 'WU-084', siteId: 'site-1', taskId: tasks[28].id, authorId: 'supervisor', quantity: 4, remarks: 'Four foundation units completed. Ready for site inspection.', evidence: [], status: 'Submitted', createdAt: at }] : [],
    defects: sample ? [{ id: 'DF-012', siteId: 'site-1', title: 'Foundation surface needs finishing', detail: 'Inspect the surface finish before the next activity. Sample issue for review.', severity: 'Medium', status: 'Reported', authorId: 'supervisor', assignee: 'Site supervisor', due: today(), verified: false }] : [],
    resources: sample ? [{ id: 'MT-021', siteId: 'site-1', kind: 'Material', name: 'Cement', quantity: 120, unit: 'bags', reference: 'INV-2041', supplier: 'Southern Building Supplies', rate: 420, authorId: 'supervisor', status: 'Pending', createdAt: at }] : [],
    reports: [], visits: [], audit: [],
  };
}
export function canReview(user: User) { return user.role === 'Owner' || user.role === 'Manager'; }
export function allowedSite(user: User, siteId: string) { return user.role === 'Owner' || user.siteIds.includes(siteId); }
export function siteStats(data: AppData, site: Site) {
  const credits = site.tasks.reduce((a, t) => a + Math.round(Math.round(t.points * 100) * Math.min(t.approved / t.planned, 1)), 0) / 100;
  const penalty = data.ledger.filter(l => l.siteId === site.id && l.type === 'Quality').reduce((a, l) => a + l.amount, 0);
  return { credits, balance: Math.max(0, site.allocation - credits), progress: Math.round(credits / site.allocation * 100), quality: Math.max(0, Math.min(100, 100 - penalty)), complete: site.tasks.filter(t => t.approved >= t.planned).length };
}
export type Action =
  | { type: 'submitWork'; id: string; siteId: string; taskId: string; quantity: number; remarks: string; evidence: string[] }
  | { type: 'reviewWork'; id: string; decision: 'Approved' | 'Changes requested'; reason: string }
  | { type: 'addDefect'; id: string; siteId: string; title: string; detail: string; severity: Defect['severity']; assignee: string; due: string }
  | { type: 'defectAction'; id: string; decision: 'verify' | 'correct' | 'close' | 'reopen'; reason: string; evidence?: string[] }
  | { type: 'addResource'; id: string; siteId: string; kind: Resource['kind']; name: string; quantity: number; unit: string; reference: string; supplier: string; rate: number }
  | { type: 'verifyResource'; id: string }
  | { type: 'submitReport'; id: string; siteId: string; date: string; summary: string; tomorrow: string; blockers: string; labour: number; hours: number }
  | { type: 'reviewReport'; id: string; decision: 'Approved' | 'Changes requested'; reason: string }
  | { type: 'checkIn'; id: string; siteId: string; location: Location | null; reason: string }
  | { type: 'checkOut'; id: string; location: Location | null; reason: string }
  | { type: 'reviewVisit'; id: string; decision: 'Accepted' | 'Rejected' }
  | { type: 'createProject'; id: string; name: string; client: string; location: string; due: string; siteName: string; capacity: string };

export class DomainError extends Error { constructor(message: string) { super(message); this.name = 'DomainError'; } }
function assert(value: unknown, message: string): asserts value { if (!value) throw new DomainError(message); }
function positive(value: number, max = 1e8) { assert(Number.isFinite(value) && value > 0 && value <= max, 'Enter a valid positive quantity.'); }
function nonnegative(value: number, max = 1e8) { assert(Number.isFinite(value) && value >= 0 && value <= max, 'Enter a valid non-negative value.'); }
export function applyAction(input: AppData, user: User, action: Action): AppData {
  assert(user.role !== 'Client', 'Client access is read-only in this release.');
  const data = structuredClone(input);
  const at = new Date().toISOString();
  const siteId = 'siteId' in action ? action.siteId : undefined;
  if (siteId) assert(data.sites.some(s => s.id === siteId) && allowedSite(user, siteId), 'This site is not assigned to you.');
  const review = (record: { authorId: string; siteId: string }) => {
    assert(canReview(user) && allowedSite(user, record.siteId), 'A manager assigned to this site must review this record.');
    assert(record.authorId !== user.id, 'You cannot approve your own record.');
  };
  let affectedSite = siteId;
  switch (action.type) {
    case 'submitWork': {
      assert(['Owner', 'Manager', 'Supervisor'].includes(user.role), 'You cannot submit work.');
      if (data.work.some(w => w.id === action.id)) return input;
      const task = data.sites.find(s => s.id === action.siteId)?.tasks.find(t => t.id === action.taskId);
      assert(task, 'Choose an activity.'); positive(action.quantity);
      const pending = data.work.filter(w => w.siteId === action.siteId && w.taskId === action.taskId && w.status === 'Submitted').reduce((a, w) => a + w.quantity, 0);
      assert(task.approved + pending + action.quantity <= task.planned, 'This quantity exceeds the remaining planned work, including pending submissions.');
      assert(action.remarks.trim(), 'Add a short work note.');
      data.work.unshift({ ...action, authorId: user.id, status: 'Submitted', createdAt: at }); break;
    }
    case 'reviewWork': {
      const work = data.work.find(w => w.id === action.id); assert(work, 'Work update not found.'); review(work); affectedSite = work.siteId;
      if (work.status === action.decision) return input;
      assert(work.status === 'Submitted', 'This revision is locked. Create a new submission for a correction.');
      if (action.decision === 'Changes requested') assert(action.reason.trim(), 'Explain the change needed.');
      if (action.decision === 'Approved') {
        assert(!data.defects.some(d => d.siteId === work.siteId && d.severity === 'Critical' && d.verified && d.status !== 'Closed'), 'A verified critical defect blocks work approval at this site until it is closed.');
        const task = data.sites.find(s => s.id === work.siteId)!.tasks.find(t => t.id === work.taskId)!;
        const previous = Math.round(Math.round(task.points * 100) * Math.min(task.approved / task.planned, 1));
        task.approved = Math.min(task.planned, task.approved + work.quantity);
        const cumulative = Math.round(Math.round(task.points * 100) * Math.min(task.approved / task.planned, 1));
        data.ledger.push({ id: `work-${work.id}`, siteId: work.siteId, sourceId: work.id, type: 'Work', amount: cumulative - previous, createdAt: at, actorId: user.id });
      }
      Object.assign(work, { status: action.decision, reviewReason: action.reason, reviewerId: user.id }); break;
    }
    case 'addDefect':
      if (data.defects.some(d => d.id === action.id)) return input;
      assert(action.title.trim() && action.detail.trim() && action.assignee.trim() && action.due, 'Complete the issue, assignee and due date.');
      data.defects.unshift({ ...action, authorId: user.id, status: 'Reported', verified: false }); break;
    case 'defectAction': {
      const defect = data.defects.find(d => d.id === action.id); assert(defect && allowedSite(user, defect.siteId), 'Issue not found.'); affectedSite = defect.siteId;
      if (action.decision === 'verify') {
        review(defect); if (defect.verified) return input;
        assert(defect.status === 'Reported', 'Only a reported issue can be verified.');
        defect.verified = true; defect.status = 'Verified';
        data.ledger.push({ id: `quality-${defect.id}`, siteId: defect.siteId, sourceId: defect.id, type: 'Quality', amount: penalties[defect.severity], createdAt: at, actorId: user.id });
      } else if (action.decision === 'correct') {
        assert(['Verified', 'Reopened'].includes(defect.status), 'This issue must be verified before correction.');
        assert(action.reason.trim() && action.evidence?.length, 'Add correction notes and at least one evidence photo.');
        defect.correction = action.reason; defect.evidence = action.evidence; defect.status = 'Awaiting reinspection';
        // The correcting author must not perform the subsequent reinspection.
        (defect as Defect & { correctionAuthorId?: string }).correctionAuthorId = user.id;
      } else {
        assert(canReview(user), 'An assigned manager must reinspect this correction.');
        assert((defect as Defect & { correctionAuthorId?: string }).correctionAuthorId !== user.id, 'You cannot reinspect your own correction.');
        assert(defect.status === 'Awaiting reinspection', 'Submit a correction before reinspection.');
        assert(action.reason.trim(), 'Record your reinspection findings.');
        defect.status = action.decision === 'close' ? 'Closed' : 'Reopened';
      } break;
    }
    case 'addResource': {
      if (data.resources.some(r => r.id === action.id)) return input;
      positive(action.quantity); nonnegative(action.rate); assert(action.name.trim() && action.unit.trim() && action.reference.trim(), 'Add the resource, unit and bill or issue reference.');
      assert(!data.resources.some(r => r.siteId === action.siteId && r.reference.trim().toLowerCase() === action.reference.trim().toLowerCase() && r.supplier.trim().toLowerCase() === action.supplier.trim().toLowerCase()), 'This supplier and bill/issue reference are already recorded.');
      data.resources.unshift({ ...action, authorId: user.id, status: 'Pending', createdAt: at }); break;
    }
    case 'verifyResource': {
      const resource = data.resources.find(r => r.id === action.id); assert(resource, 'Resource not found.'); review(resource); affectedSite = resource.siteId;
      if (resource.status === 'Verified') return input; resource.status = 'Verified'; break;
    }
    case 'submitReport': {
      if (data.reports.some(r => r.id === action.id)) return input;
      assert(action.summary.trim() && action.date && action.tomorrow.trim(), 'Add today’s summary, date and tomorrow’s plan.');
      nonnegative(action.labour, 100000); nonnegative(action.hours, 24); assert(Number.isInteger(action.labour), 'Headcount must be a whole number.');
      assert(!data.reports.some(r => r.siteId === action.siteId && r.date === action.date && r.status !== 'Changes requested'), 'A report already exists for this site and date.');
      data.reports.unshift({ ...action, authorId: user.id, status: 'Submitted', createdAt: at }); break;
    }
    case 'reviewReport': {
      const report = data.reports.find(r => r.id === action.id); assert(report, 'Report not found.'); review(report); affectedSite = report.siteId;
      if (report.status === action.decision) return input; assert(report.status === 'Submitted', 'This report revision is locked.');
      if (action.decision === 'Changes requested') assert(action.reason.trim(), 'Explain the change needed.');
      Object.assign(report, { status: action.decision, reviewerId: user.id, reviewReason: action.reason }); break;
    }
    case 'checkIn':
      assert(user.role === 'Manager' || user.role === 'Supervisor', 'Attendance is for managers and supervisors.');
      if (data.visits.some(v => v.id === action.id)) return input;
      assert(!data.visits.some(v => v.authorId === user.id && !v.outAt), 'Check out of your current visit first.');
      assert(action.reason.trim(), 'Explain this attendance exception. Actual site boundaries are not configured yet.');
      data.visits.unshift({ id: action.id, siteId: action.siteId, authorId: user.id, authorRole: user.role, inAt: at, inLocation: action.location, reason: action.reason, status: 'Pending review' }); break;
    case 'checkOut': {
      const visit = data.visits.find(v => v.id === action.id); assert(visit && visit.authorId === user.id && !visit.outAt, 'No open visit found.');
      assert(action.reason.trim(), 'Add an exception reason for the unconfigured site boundary.');
      visit.outAt = at; visit.outLocation = action.location; visit.reason += ` | Checkout: ${action.reason}`; visit.status = 'Pending review'; affectedSite = visit.siteId; break;
    }
    case 'reviewVisit': {
      const visit = data.visits.find(v => v.id === action.id); assert(visit, 'Visit not found.'); review(visit); affectedSite = visit.siteId;
      assert(visit.authorRole !== 'Manager' || user.role === 'Owner', 'Manager attendance exceptions require owner review.');
      assert(visit.outAt, 'The visit must be checked out before final review.');
      assert(visit.status === 'Pending review', 'This attendance decision is locked.');
      Object.assign(visit, { status: action.decision, reviewerId: user.id }); break;
    }
    case 'createProject': {
      assert(user.role === 'Owner', 'Only an owner can create projects.');
      if (data.projects.some(p => p.id === action.id)) return input;
      assert(action.name.trim() && action.siteName.trim() && action.client.trim() && action.due, 'Complete the project and first site details.');
      data.projects.unshift({ id: action.id, name: action.name, client: action.client, location: action.location, due: action.due });
      data.sites.unshift({ id: `${action.id}-site`, projectId: action.id, name: action.siteName, location: action.location, capacity: action.capacity, due: action.due, allocation: 1000, tasks: templateTasks(), templateVersion: '1.0-draft', centre: null }); break;
    }
  }
  data.revision++;
  data.audit.unshift({ id: id(), actorId: user.id, action: action.type.replace(/([A-Z])/g, ' $1').toLowerCase(), siteId: affectedSite, createdAt: at });
  return data;
}

export function visibleData(data: AppData, user: User): AppData {
  const sites = data.sites.filter(s => allowedSite(user, s.id)); const ids = new Set(sites.map(s => s.id));
  const scoped = <T extends { siteId: string }>(records: T[]) => records.filter(r => ids.has(r.siteId));
  return { ...data, sites, projects: data.projects.filter(p => sites.some(s => s.projectId === p.id)),
    work: scoped(data.work).filter(w => user.role !== 'Client' && (user.role !== 'Supervisor' || w.authorId === user.id)),
    defects: user.role === 'Client' ? [] : scoped(data.defects), resources: user.role === 'Client' ? [] : scoped(data.resources),
    reports: user.role === 'Client' ? [] : scoped(data.reports),
    visits: user.role === 'Client' ? [] : scoped(data.visits).filter(v => user.role !== 'Supervisor' || v.authorId === user.id),
    ledger: user.role === 'Client' ? [] : scoped(data.ledger),
    audit: user.role === 'Owner' ? data.audit : data.audit.filter(a => a.siteId && ids.has(a.siteId) && user.role !== 'Client' && (user.role !== 'Supervisor' || a.actorId === user.id)),
  };
}
