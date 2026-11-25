import { describe, it, expect } from 'vitest';
import { actionSchema, inviteSchema } from './validation';
describe('API action validation', () => {
  it('rejects injected authors, invalid quantities and unsupported actions', () => {
    const input = { type: 'submitWork', id: 'wu', siteId: 'site-1', taskId: 'task-1', quantity: 4, remarks: 'Done', evidence: [] };
    expect(actionSchema.safeParse(input).success).toBe(true);
    expect(actionSchema.safeParse({ ...input, authorId: 'manager' }).success).toBe(false);
    expect(actionSchema.safeParse({ ...input, quantity: -1 }).success).toBe(false);
    expect(actionSchema.safeParse({ type: 'setRole', role: 'Owner' }).success).toBe(false);
  });
  it('validates coordinates, roles and field lengths', () => {
    expect(actionSchema.safeParse({ type: 'checkIn', id: 'a', siteId: 'site-1', location: { lat: 200, lng: 0, accuracy: 10, capturedAt: new Date().toISOString() }, reason: 'GPS' }).success).toBe(false);
    expect(inviteSchema.safeParse({ name: 'Person', email: 'p@example.com', role: 'Superadmin', siteIds: [] }).success).toBe(false);
  });
});
