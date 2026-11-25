import { z } from 'zod';
const text = z.string().trim().max(4000);
const short = z.string().trim().min(1).max(160);
const identifier = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_-]+$/);
const quantity = z.number().finite().positive().max(1e8);
const evidence = z.array(identifier).max(4);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !Number.isNaN(Date.parse(v)), 'Invalid date');
const location = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracy: z.number().finite().nonnegative().max(1e6), capturedAt: z.iso.datetime() }).strict().nullable();
const review = { id: identifier, decision: z.enum(['Approved', 'Changes requested']), reason: text };
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('submitWork'), id: identifier, siteId: identifier, taskId: identifier, quantity, remarks: text.min(1), evidence }).strict(),
  z.object({ type: z.literal('reviewWork'), ...review }).strict(),
  z.object({ type: z.literal('addDefect'), id: identifier, siteId: identifier, title: short, detail: text.min(1), severity: z.enum(['Low', 'Medium', 'High', 'Critical']), assignee: short, due: date }).strict(),
  z.object({ type: z.literal('defectAction'), id: identifier, decision: z.enum(['verify', 'correct', 'close', 'reopen']), reason: text, evidence: evidence.optional() }).strict(),
  z.object({ type: z.literal('addResource'), id: identifier, siteId: identifier, kind: z.enum(['Material', 'Machinery', 'Diesel']), name: short, quantity, unit: short, reference: short, supplier: z.string().trim().max(160), rate: z.number().finite().nonnegative().max(1e8) }).strict(),
  z.object({ type: z.literal('verifyResource'), id: identifier }).strict(),
  z.object({ type: z.literal('submitReport'), id: identifier, siteId: identifier, date, summary: text.min(1), tomorrow: text.min(1), blockers: text, labour: z.number().int().min(0).max(100000), hours: z.number().min(0).max(24) }).strict(),
  z.object({ type: z.literal('reviewReport'), ...review }).strict(),
  z.object({ type: z.literal('checkIn'), id: identifier, siteId: identifier, location, reason: text.min(1) }).strict(),
  z.object({ type: z.literal('checkOut'), id: identifier, location, reason: text.min(1) }).strict(),
  z.object({ type: z.literal('reviewVisit'), id: identifier, decision: z.enum(['Accepted', 'Rejected']) }).strict(),
  z.object({ type: z.literal('createProject'), id: identifier, name: short, client: short, location: short, due: date, siteName: short, capacity: short }).strict(),
]);
export const inviteSchema = z.object({ name: short, email: z.email().max(254).transform(s => s.toLowerCase()), role: z.enum(['Owner', 'Manager', 'Supervisor', 'Client']), siteIds: z.array(identifier).max(1000) }).strict();
export const loginSchema = z.object({ email: z.email().max(254).transform(s => s.toLowerCase()), password: z.string().min(1).max(256) }).strict();
