import crypto from 'crypto';
import { promisify } from 'util';
import { HUBS } from '../domain';
import { getPool } from '../db/pool';
import { ROLES, type AppUser, type Role } from './permissions';

/**
 * App accounts: name + PIN, created by the superadmin. PINs are salted scrypt hashes; sessions are
 * random tokens kept in an HttpOnly cookie, stored here only as a sha256. Five wrong tries lock a
 * name for 15 minutes (unknown names too, so the answer never hints at who exists).
 */

const scrypt = promisify(crypto.scrypt) as (pin: string, salt: Buffer, len: number) => Promise<Buffer>;
export const SESSION_HOURS = 16; // one long shift
const MAX_TRIES = 5;
const LOCK_MS = 15 * 60_000;

export class AccountError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pin, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [kind, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const given = await scrypt(pin, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(given, expected);
}

const nameKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

function checkName(name: unknown): string {
  const n = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (n.length < 2 || n.length > 40) throw new AccountError('Name: 2 to 40 characters.');
  if (!/^[\p{L}][\p{L}\p{N} .'’-]*$/u.test(n)) throw new AccountError('Name: letters, numbers, spaces, dots and dashes only.');
  return n;
}

function checkRole(role: unknown, hub: unknown): { role: Role; hub: string | null } {
  if (!ROLES.includes(role as Role)) throw new AccountError('Role must be area, senior or superadmin.');
  const h = hub === undefined || hub === null || hub === '' ? null : String(hub);
  if (h !== null && !HUBS.includes(h as (typeof HUBS)[number])) throw new AccountError('Unknown area.');
  if (role === 'area' && !h) throw new AccountError('An area supervisor needs their area (East, West, South or Hospitality).');
  return { role: role as Role, hub: h };
}

function checkPin(pin: unknown, role: Role): string {
  const p = String(pin ?? '');
  if (!/^\d+$/.test(p)) throw new AccountError('The PIN must be digits only.');
  const min = role === 'area' ? 4 : 6;
  if (p.length < min || p.length > 8) throw new AccountError(`The PIN must be ${min} to 8 digits${role === 'area' ? '' : ' for admins'}.`);
  return p;
}

interface UserRow {
  id: string;
  name: string;
  role: Role;
  hub: string | null;
  pin_hash: string;
  active: boolean;
  created_at: Date;
  last_login_at: Date | null;
}
export type PublicUser = Omit<UserRow, 'pin_hash'>;
const publicUser = ({ pin_hash: _ignored, ...u }: UserRow): PublicUser => u;
export const asAppUser = (u: Pick<UserRow, 'id' | 'name' | 'role' | 'hub'>): AppUser => ({ id: u.id, name: u.name, role: u.role, hub: u.hub });

export async function audit(by: Pick<AppUser, 'id' | 'name'> | null, action: string, detail = ''): Promise<void> {
  await getPool().query('INSERT INTO audit_log (user_id, user_name, action, detail) VALUES ($1, $2, $3, $4)', [
    by?.id ?? null,
    by?.name ?? 'system',
    action,
    detail.slice(0, 500),
  ]);
}

export async function hasUsers(): Promise<boolean> {
  const { rows } = await getPool().query<{ n: number }>('SELECT COUNT(*)::int AS n FROM app_users');
  return rows[0].n > 0;
}

export async function listUsers(): Promise<PublicUser[]> {
  const { rows } = await getPool().query<UserRow>('SELECT * FROM app_users ORDER BY role DESC, name');
  return rows.map(publicUser);
}

export async function createUser(input: { name?: unknown; role?: unknown; hub?: unknown; pin?: unknown }, by: AppUser | null): Promise<PublicUser> {
  const name = checkName(input.name);
  const { role, hub } = checkRole(input.role, input.hub);
  const pin = checkPin(input.pin, role);
  const pinHash = await hashPin(pin);
  try {
    const { rows } = await getPool().query<UserRow>(
      'INSERT INTO app_users (name, name_key, role, hub, pin_hash) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, nameKey(name), role, role === 'area' ? hub : null, pinHash],
    );
    return publicUser(rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new AccountError(`There’s already someone called ${name}.`);
    throw err;
  } finally {
    if (by) await audit(by, 'user_added', `${name} (${role}${hub && role === 'area' ? `, ${hub}` : ''})`).catch(() => undefined);
  }
}

async function activeSuperadmins(exceptId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>("SELECT COUNT(*)::int AS n FROM app_users WHERE role = 'superadmin' AND active AND id <> $1", [exceptId]);
  return rows[0].n;
}

async function getUserRow(id: string): Promise<UserRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AccountError('Not found.', 404);
  const { rows } = await getPool().query<UserRow>('SELECT * FROM app_users WHERE id = $1', [id]);
  if (!rows[0]) throw new AccountError('Not found.', 404);
  return rows[0];
}

export async function updateUser(id: string, input: { name?: unknown; role?: unknown; hub?: unknown; pin?: unknown; active?: unknown }, by: AppUser): Promise<PublicUser> {
  const u = await getUserRow(id);
  const name = input.name !== undefined ? checkName(input.name) : u.name;
  const { role, hub } = checkRole(input.role ?? u.role, input.hub !== undefined ? input.hub : u.hub);
  const active = input.active === undefined ? u.active : input.active === true;
  if (u.role === 'superadmin' && (role !== 'superadmin' || !active) && (await activeSuperadmins(u.id)) === 0) {
    throw new AccountError('That’s the last superadmin: add another superadmin first.');
  }
  const newPin = input.pin !== undefined && input.pin !== '';
  if (!newPin && u.role === 'area' && role !== 'area') throw new AccountError('Promoting to admin needs a new 6–8 digit PIN.');
  const pinHash = newPin ? await hashPin(checkPin(input.pin, role)) : u.pin_hash;
  try {
    const { rows } = await getPool().query<UserRow>(
      'UPDATE app_users SET name = $2, name_key = $3, role = $4, hub = $5, pin_hash = $6, active = $7 WHERE id = $1 RETURNING *',
      [id, name, nameKey(name), role, role === 'area' ? hub : null, pinHash, active],
    );
    // A new PIN, a new role or switching someone off logs them out everywhere.
    if (pinHash !== u.pin_hash || role !== u.role || !active) await getPool().query('DELETE FROM app_sessions WHERE user_id = $1', [id]);
    const changes = [
      name !== u.name && `name → ${name}`,
      role !== u.role && `role → ${role}`,
      (hub ?? null) !== (u.hub ?? null) && `area → ${hub ?? 'none'}`,
      pinHash !== u.pin_hash && 'new PIN',
      active !== u.active && (active ? 'switched on' : 'switched off'),
    ].filter(Boolean);
    await audit(by, 'user_changed', `${u.name}: ${changes.join(', ') || 'no change'}`);
    return publicUser(rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new AccountError(`There’s already someone called ${name}.`);
    throw err;
  }
}

export async function deleteUser(id: string, by: AppUser): Promise<void> {
  const u = await getUserRow(id);
  if (u.role === 'superadmin' && (await activeSuperadmins(u.id)) === 0) throw new AccountError('That’s the last superadmin: add another superadmin first.');
  await getPool().query('DELETE FROM app_users WHERE id = $1', [id]);
  await audit(by, 'user_removed', u.name);
}

// ---------------------------------------------------------------- login and sessions

const tries = new Map<string, { n: number; lockedUntil: number }>();
/** For tests. */
export const resetLoginLimits = () => tries.clear();

const WRONG = 'Wrong name or PIN.';

export async function login(nameIn: unknown, pinIn: unknown, now = Date.now()): Promise<{ user: PublicUser; token: string }> {
  const key = nameKey(String(nameIn ?? '')).slice(0, 60);
  const pin = String(pinIn ?? '').slice(0, 16);
  const t = tries.get(key);
  if (t && t.lockedUntil > now) throw new AccountError('Too many wrong tries. Wait 15 minutes, or ask the superadmin.', 429);

  const { rows } = await getPool().query<UserRow>('SELECT * FROM app_users WHERE name_key = $1', [key]);
  const u = rows[0];
  // Hash even for unknown names, so the time taken doesn't say who exists.
  const ok = u ? await verifyPin(pin, u.pin_hash) : (await verifyPin(pin, DUMMY_HASH), false);
  if (!ok || !u.active) {
    const n = (t && !t.lockedUntil ? t.n : 0) + 1;
    if (tries.size > 10_000) tries.clear(); // don't let made-up names fill the memory
    tries.set(key, n >= MAX_TRIES ? { n: 0, lockedUntil: now + LOCK_MS } : { n, lockedUntil: 0 });
    if (n >= MAX_TRIES) await audit(null, 'login_locked', key).catch(() => undefined);
    throw new AccountError(WRONG, 401);
  }
  tries.delete(key);
  const token = crypto.randomBytes(32).toString('base64url');
  await getPool().query('INSERT INTO app_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
    sha256(token),
    u.id,
    new Date(now + SESSION_HOURS * 3_600_000),
  ]);
  await getPool().query('UPDATE app_users SET last_login_at = $2 WHERE id = $1', [u.id, new Date(now)]);
  await getPool().query('DELETE FROM app_sessions WHERE expires_at < $1', [new Date(now)]);
  return { user: publicUser(u), token };
}

const DUMMY_HASH = `scrypt$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(32).toString('base64')}`;
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export async function sessionUser(token: string | undefined, now = Date.now()): Promise<AppUser | null> {
  if (!token || token.length > 100) return null;
  const { rows } = await getPool().query<UserRow>(
    `SELECT u.* FROM app_sessions s JOIN app_users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > $2 AND u.active`,
    [sha256(token), new Date(now)],
  );
  return rows[0] ? asAppUser(rows[0]) : null;
}

export async function logout(token: string | undefined): Promise<void> {
  if (token) await getPool().query('DELETE FROM app_sessions WHERE token_hash = $1', [sha256(token)]);
}
