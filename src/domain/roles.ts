/**
 * Capability matrix — who may do what (spec §11 lines 2464–2473; plan §3.4, §7). Pure module: no React Native
 * or Expo imports. Routes call can(session.role, action) after requireSession (403 on false); the console hides
 * controls the role lacks; status.ts uses it for transitions. Residents and stewards write only their own
 * civic actions, stewards add duplicate flagging and never change status or severity, inspectors run triage,
 * supervisors schedule and send alerts up to warning, directors own settings, users, scenarios and emergency
 * alerts, and the auditor reads everything and writes nothing.
 */
import type { Role } from './types';

export const ACTIONS = [
  'report',
  'vote',
  'comment',
  'follow',
  'verify',
  'flag',
  'flag_duplicate',
  'triage',
  'confirm_severity',
  'mitigate',
  'merge',
  'schedule',
  'complete',
  'ack_emergency',
  'moderate',
  'manage_users',
  'manage_settings',
  'create_scenario',
  'send_alert',
  'send_emergency_alert',
  'read_audit',
  'export',
] as const;
export type Action = (typeof ACTIONS)[number];

const RESIDENT: readonly Action[] = ['report', 'vote', 'comment', 'follow', 'verify', 'flag']; // spec: §11 line 2468 Resident
const STEWARD: readonly Action[] = [...RESIDENT, 'flag_duplicate']; // spec: §11 line 2469 Steward — flags duplicates, cannot change status or severity
const INSPECTOR: readonly Action[] = [...STEWARD, 'triage', 'confirm_severity', 'mitigate', 'merge', 'complete', 'read_audit', 'export']; // spec: §11 line 2470 Inspector
const SUPERVISOR: readonly Action[] = [...INSPECTOR, 'schedule', 'ack_emergency', 'moderate', 'send_alert']; // spec: §11 line 2471 Supervisor — alerts ≤ warning, cannot change weights
const DIRECTOR: readonly Action[] = [...SUPERVISOR, 'manage_users', 'manage_settings', 'create_scenario', 'send_emergency_alert']; // spec: §11 line 2472 Director
const AUDITOR: readonly Action[] = ['read_audit', 'export']; // spec: §11 line 2473 Auditor — everything read, any write denied

export const CAPABILITIES: Record<Role, readonly Action[]> = {
  resident: RESIDENT,
  steward: STEWARD,
  inspector: INSPECTOR,
  supervisor: SUPERVISOR,
  director: DIRECTOR,
  auditor: AUDITOR,
};

/** Staff roles sign in by email and receive emergency pages (plan §3.4). */
export const STAFF_ROLES: readonly Role[] = ['inspector', 'supervisor', 'director'];

/** No role (no session, or an unknown role string from bad data) can do nothing. */
export function can(role: Role | string | null | undefined, action: Action): boolean {
  if (!role) return false;
  const caps = (CAPABILITIES as Record<string, readonly Action[] | undefined>)[role];
  return caps ? caps.includes(action) : false;
}

export function isStaff(role: Role | string | null | undefined): boolean {
  return !!role && (STAFF_ROLES as readonly string[]).includes(role);
}
