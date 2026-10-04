/**
 * Who may do what in the Gatekeeper app.
 *   area       (area supervisor)   logs only in their own hub, sees every hub, fixes their own logs
 *   senior     (senior supervisor) sees, adds, edits and deletes everything; dashboard, events, reports
 *   superadmin                     all of that, plus settings and accounts
 */

export type Role = 'area' | 'senior' | 'superadmin';
export const ROLES: readonly Role[] = ['area', 'senior', 'superadmin'];

export interface AppUser {
  id: string;
  name: string;
  role: Role;
  hub: string | null; // an area supervisor's own hub
}

export type Action = 'log' | 'view' | 'edit' | 'delete' | 'dashboard' | 'events' | 'settings' | 'users';

export function can(user: AppUser, action: Action, ctx: { hub?: string; ownerId?: string | null } = {}): boolean {
  if (user.role === 'superadmin') return true;
  if (user.role === 'senior') return action !== 'settings' && action !== 'users';
  switch (action) {
    case 'view':
      return true;
    case 'log':
      return ctx.hub !== undefined && ctx.hub === user.hub;
    case 'edit':
      return !!ctx.ownerId && ctx.ownerId === user.id;
    default:
      return false;
  }
}
