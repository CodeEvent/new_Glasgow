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

function checkPin(pin: unknown): string {
  const p = String(pin ?? '');
  if (!/^\d+$/.test(p)) throw new AccountError('The PIN must be digits only.');
  if (p.length < 6 || p.length > 8) throw new AccountError('The PIN must be 6 to 8 digits.');
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
  const pin = checkPin(input.pin);
  const pinHash = await hashPin(pin);
  try {
    const { rows } = await getPool().query<UserRow>(
      'INSERT INTO app_users (name, name_key, role, hub, pin_hash) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, nameKey(name), role, role === 'area' ? hub : null, pinHash],
    );
    forgetCache();
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

export async function updateUser(
  id: string,
  input: { name?: unknown; role?: unknown; hub?: unknown; pin?: unknown; active?: unknown; unlock?: unknown },
  by: AppUser,
): Promise<PublicUser> {
  const u = await getUserRow(id);
  if (input.unlock === true) {
    unlockName(u.name);
    await forgetDevices(u.id);
    await audit(by, 'user_unlocked', u.name);
  }
  const name = input.name !== undefined ? checkName(input.name) : u.name;
  const { role, hub } = checkRole(input.role ?? u.role, input.hub !== undefined ? input.hub : u.hub);
  const active = input.active === undefined ? u.active : input.active === true;
  if (u.role === 'superadmin' && (role !== 'superadmin' || !active) && (await activeSuperadmins(u.id)) === 0) {
    throw new AccountError('That’s the last superadmin: add another superadmin first.');
  }
  const newPin = input.pin !== undefined && input.pin !== '';
  if (!newPin && u.role === 'area' && role !== 'area') throw new AccountError('Promoting someone to admin needs a new PIN for them.');
  const pinHash = newPin ? await hashPin(checkPin(input.pin)) : u.pin_hash;
  try {
    const { rows } = await getPool().query<UserRow>(
      'UPDATE app_users SET name = $2, name_key = $3, role = $4, hub = $5, pin_hash = $6, active = $7 WHERE id = $1 RETURNING *',
      [id, name, nameKey(name), role, role === 'area' ? hub : null, pinHash, active],
    );
    // A new PIN, a new role or switching someone off logs them out everywhere.
    if (pinHash !== u.pin_hash || role !== u.role || !active) {
      await getPool().query('DELETE FROM app_sessions WHERE user_id = $1', [id]);
      await forgetDevices(id);
    }
    const changes = [
      name !== u.name && `name → ${name}`,
      role !== u.role && `role → ${role}`,
      (hub ?? null) !== (u.hub ?? null) && `area → ${hub ?? 'none'}`,
      pinHash !== u.pin_hash && 'new PIN',
      active !== u.active && (active ? 'switched on' : 'switched off'),
    ].filter(Boolean);
    forgetCache();
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
  forgetCache();
  await audit(by, 'user_removed', u.name);
}

// ---------------------------------------------------------------- login and sessions

// ---------------------------------------------------------------- login limits
//
// Strangers (a phone that has never logged in as that person):
//   name + device   5 wrong PINs -> that name is locked on that device
//   device          30 wrong PINs across all names -> that device is stopped
//   name            20 wrong PINs from any devices -> locked everywhere; each new lock lasts twice as
//                   long (15 min, 30, 60 ... up to 24 h; back to 15 min after a day without locks)
// A trusted phone (logged in before with the right PIN, gk_device cookie) skips the device and name
// locks, so someone guessing on the venue Wi-Fi can't lock staff out. Its cookie is cancelled after 5
// wrong PINs (a stolen phone gets 5 guesses), and by a new PIN, role, switching off or unlocking.
//
// Counts are never forgotten on a timer: they clear on a right PIN, or when a lock runs out.
// Real people's names (known up front) have exact counters of their own, never dropped, so nothing
// done with made-up names can lock out real staff. Made-up names go in a fixed-size table indexed by a
// secret keyed hash: nothing is evicted (a flood can't reset a count) and memory stays fixed.
// Every try is counted before anything is awaited.

const MAX_NAME_TRIES = 20;
const MAX_DEVICE_TRIES = 30;
const MAX_LOCK_MS = 24 * 3_600_000;

interface Counters {
  locked(key: string, now: number): boolean;
  /** Counts a try; true if this try started a lock. */
  count(key: string, now: number, max: number, doubling: boolean): boolean;
  /** A right PIN: forget the wrong tries (a running doubling level stays for a day). */
  clearCount(key: string, now: number): void;
  /** Superadmin unlock. */
  clear(key: string): void;
  reset(): void;
}

type Slot = { n: number; lockedUntil: number; level: number; lastLockAt: number };
function bump(t: Slot, now: number, max: number, doubling: boolean): boolean {
  if (t.lockedUntil && t.lockedUntil <= now) {
    t.n = 0; // the lock ran out
    t.lockedUntil = 0;
  }
  t.n = Math.min(t.n + 1, 65_535);
  if (t.n < max) return false;
  t.level = !doubling || now - t.lastLockAt > MAX_LOCK_MS ? 1 : Math.min(t.level + 1, 12);
  t.lastLockAt = now;
  t.lockedUntil = now + Math.min(LOCK_MS * 2 ** (t.level - 1), MAX_LOCK_MS);
  return true;
}

/** Exact counters for real names (and real name + device pairs, capped: oldest unlocked go first). */
class ExactCounters implements Counters {
  private map = new Map<string, Slot>();
  constructor(private readonly capped: boolean) {}
  locked(key: string, now: number) {
    return (this.map.get(key)?.lockedUntil ?? 0) > now;
  }
  count(key: string, now: number, max: number, doubling: boolean) {
    let t = this.map.get(key);
    if (!t) {
      t = { n: 0, lockedUntil: 0, level: 0, lastLockAt: 0 };
      this.map.set(key, t);
      if (this.capped && this.map.size > trackingCap) {
        for (const [k, e] of this.map) {
          if (this.map.size <= trackingCap * 0.9) break;
          if (e.lockedUntil <= now && k !== key) this.map.delete(k);
        }
      }
    }
    if (t.lockedUntil > now) return false;
    return bump(t, now, max, doubling);
  }
  clearCount(key: string, now: number) {
    const t = this.map.get(key);
    if (t && t.lockedUntil <= now) t.n = 0;
  }
  clear(key: string) {
    this.map.delete(key);
  }
  reset() {
    this.map.clear();
  }
}

/** Made-up names: a fixed table; a key's slot comes from a keyed hash, so nobody can aim at a slot. */
class SlotTable implements Counters {
  private secret = crypto.randomBytes(32);
  private n!: Uint16Array;
  private lockedUntil!: Float64Array;
  private level!: Uint8Array;
  private lastLockAt!: Float64Array;
  constructor(public size: number) {
    this.resize(size);
  }
  resize(size: number) {
    this.size = size;
    this.n = new Uint16Array(size);
    this.lockedUntil = new Float64Array(size);
    this.level = new Uint8Array(size);
    this.lastLockAt = new Float64Array(size);
  }
  private slot(key: string): number {
    return crypto.createHmac('sha256', this.secret).update(key).digest().readUInt32BE(0) % this.size;
  }
  locked(key: string, now: number) {
    return this.lockedUntil[this.slot(key)] > now;
  }
  count(key: string, now: number, max: number, doubling: boolean) {
    const i = this.slot(key);
    if (this.lockedUntil[i] > now) return false;
    const t = { n: this.n[i], lockedUntil: this.lockedUntil[i], level: this.level[i], lastLockAt: this.lastLockAt[i] };
    const started = bump(t, now, max, doubling);
    [this.n[i], this.lockedUntil[i], this.level[i], this.lastLockAt[i]] = [t.n, t.lockedUntil, t.level, t.lastLockAt];
    return started;
  }
  clearCount() {
    /* made-up names never log in */
  }
  clear(key: string) {
    const i = this.slot(key);
    this.n[i] = 0;
    this.lockedUntil[i] = 0;
  }
  reset() {
    for (const a of [this.n, this.lockedUntil, this.level, this.lastLockAt]) a.fill(0);
  }
}

type Tries = { n: number; lockedUntil: number };
const realNames = new ExactCounters(false); // bounded by the number of staff
const realPairs = new ExactCounters(true);
const madeUpNames = new SlotTable(1 << 17);
const madeUpPairs = new SlotTable(1 << 17);
const unlocks = new Map<string, number>(); // real names: bumped by an unlock, so their old device locks don't apply
const deviceTries = new Map<string, Tries>(); // per connection (no names involved)
const tokenTries = new Map<string, Tries>(); // wrong PINs sent with a trusted-phone cookie
let trackingCap = 10_000;

/** For tests: shrink the made-up-name tables (1 = every made-up name shares one slot). */
export const setMadeUpTableSize = (n: number) => {
  madeUpNames.resize(n);
  madeUpPairs.resize(n);
};

// Real names and trusted phones, kept in memory so the limits above need no await.
let cache: Promise<{ names: Map<string, string>; devices: Map<string, string> }> | null = null;
function loadCache() {
  cache ??= (async () => {
    const [u, d] = await Promise.all([
      getPool().query<{ id: string; name_key: string }>('SELECT id, name_key FROM app_users WHERE active'),
      getPool().query<{ token_hash: string; user_id: string }>("SELECT token_hash, user_id FROM app_devices WHERE last_used_at > NOW() - INTERVAL '90 days'"),
    ]);
    return { names: new Map(u.rows.map((r) => [r.name_key, r.id])), devices: new Map(d.rows.map((r) => [r.token_hash, r.user_id])) };
  })().catch((err) => {
    cache = null;
    throw err;
  });
  return cache;
}
const forgetCache = () => {
  cache = null;
};

/** For tests. */
export const resetLoginLimits = () => {
  for (const c of [realNames, realPairs, madeUpNames, madeUpPairs]) c.reset();
  unlocks.clear();
  deviceTries.clear();
  tokenTries.clear();
  forgetCache();
};
/** For tests: entries kept in the per-connection list before the oldest are dropped. */
export const setLoginTrackingCap = (n: number) => {
  trackingCap = n;
};
/** For tests. */
export const _deviceFailures = (ip: string) => deviceTries.get(deviceKey(ip))?.n ?? 0;

/** One key per device: IPv4 as is, IPv6 by its /64 network (a phone can change the rest at will). */
export function deviceKey(ip: string): string {
  const v = ip.trim().toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return mapped[1];
  if (!v.includes(':')) return v || 'unknown';
  const [head, tail = ''] = v.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = v.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${full.slice(0, 4).map((x) => (x || '0').replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

const isLocked = (t: Tries | undefined, now: number) => !!t && t.lockedUntil > now;

/** Per-connection and per-cookie counts: a small map, oldest entries dropped first (no names in it). */
function countSimple(map: Map<string, Tries>, key: string, max: number, now: number): boolean {
  let t = map.get(key);
  if (!t || (t.lockedUntil && t.lockedUntil <= now)) t = { n: 0, lockedUntil: 0 };
  map.delete(key);
  map.set(key, t);
  t.n += 1;
  const lockedNow = t.n >= max && !t.lockedUntil;
  if (lockedNow) t.lockedUntil = now + LOCK_MS;
  if (map.size > trackingCap) {
    for (const [k, e] of map) {
      if (map.size <= trackingCap * 0.9) break;
      if (!isLocked(e, now)) map.delete(k);
    }
    for (const k of map.keys()) {
      if (map.size <= trackingCap * 5) break;
      map.delete(k);
    }
  }
  return lockedNow;
}

const pairKey = (device: string, name: string) => `${device}|${name}|${unlocks.get(name) ?? 0}`;
const WRONG = 'Wrong name or PIN.';
const LOCKED = 'Too many wrong tries. Wait, or ask the superadmin to unlock you.';

/** Cancels a person's trusted phones (new PIN, new role, switched off, unlocked). */
async function forgetDevices(userId: string): Promise<void> {
  await getPool().query('DELETE FROM app_devices WHERE user_id = $1', [userId]);
  forgetCache();
}

/** Superadmin: clear a name's lock (e.g. someone was guessing at it), on every device. */
export function unlockName(name: string): void {
  const key = nameKey(name);
  realNames.clear(key);
  unlocks.set(key, (unlocks.get(key) ?? 0) + 1);
}

export async function login(
  nameIn: unknown,
  pinIn: unknown,
  now = Date.now(),
  ip = 'unknown',
  deviceToken?: string,
): Promise<{ user: PublicUser; token: string; deviceToken: string }> {
  const key = nameKey(String(nameIn ?? '')).slice(0, 60);
  const pin = String(pinIn ?? '').slice(0, 16);
  const device = deviceKey(ip);
  const { names, devices } = await loadCache();

  // ---- from here to the first await below: no awaits, so tries sent at once are all counted
  const userId = names.get(key);
  const tokenHash = deviceToken && deviceToken.length <= 100 ? sha256(deviceToken) : null;
  const trusted = !!userId && !!tokenHash && devices.get(tokenHash) === userId;
  const pk = pairKey(device, key);
  const [names_, pairs] = userId ? [realNames, realPairs] : [madeUpNames, madeUpPairs];
  if (pairs.locked(pk, now)) throw new AccountError(LOCKED, 429);
  if (!trusted && (isLocked(deviceTries.get(device), now) || names_.locked(key, now))) throw new AccountError(LOCKED, 429);
  const pairLocked = pairs.count(pk, now, MAX_TRIES, false);
  const nameLocked = names_.count(key, now, MAX_NAME_TRIES, true); // trusted phones' wrong PINs count too (the lock just doesn't stop them)
  // A trusted cookie gets 5 wrong PINs in all, wherever they come from; then it's cancelled.
  const tokenSpent = trusted ? countSimple(tokenTries, tokenHash!, MAX_TRIES, now) : false;
  if (tokenSpent) devices.delete(tokenHash!);
  if (!trusted) countSimple(deviceTries, device, MAX_DEVICE_TRIES, now);
  // ----

  const { rows } = await getPool().query<UserRow>('SELECT * FROM app_users WHERE name_key = $1', [key]);
  const u = rows[0];
  // Hash even for unknown names, so the time taken doesn't say who exists.
  const ok = u ? await verifyPin(pin, u.pin_hash) : (await verifyPin(pin, DUMMY_HASH), false);
  if (!ok || !u.active) {
    if (tokenSpent) {
      await getPool().query('DELETE FROM app_devices WHERE token_hash = $1', [tokenHash]);
      tokenTries.delete(tokenHash!);
      await audit(null, 'device_cancelled', `${key}: 5 wrong PINs on a trusted phone`).catch(() => undefined);
    }
    if (u && (pairLocked || nameLocked)) await audit(null, 'login_locked', `${key}${nameLocked ? ' (all devices)' : ''}`).catch(() => undefined);
    throw new AccountError(WRONG, 401);
  }
  if (tokenHash) tokenTries.delete(tokenHash);
  // Right PIN: give the tries back (the name keeps its lock level for a day).
  realPairs.clear(pk);
  realNames.clearCount(key, now);
  const d = deviceTries.get(device);
  if (d && !isLocked(d, now)) d.n = Math.max(0, d.n - 1);
  if (pin.length < 6) throw new AccountError('PINs are 6 digits now: ask the superadmin for a new 6-digit PIN.', 403);

  const token = crypto.randomBytes(32).toString('base64url');
  await getPool().query('INSERT INTO app_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
    sha256(token),
    u.id,
    new Date(now + SESSION_HOURS * 3_600_000),
  ]);
  await getPool().query('UPDATE app_users SET last_login_at = $2 WHERE id = $1', [u.id, new Date(now)]);
  await getPool().query('DELETE FROM app_sessions WHERE expires_at < $1', [new Date(now)]);
  // This phone is now trusted for this person.
  const device_ = trusted ? deviceToken! : crypto.randomBytes(32).toString('base64url');
  if (trusted) {
    await getPool().query('UPDATE app_devices SET last_used_at = $2 WHERE token_hash = $1', [sha256(device_), new Date(now)]);
  } else {
    await getPool().query('INSERT INTO app_devices (token_hash, user_id) VALUES ($1, $2)', [sha256(device_), u.id]);
    devices.set(sha256(device_), u.id);
  }
  return { user: publicUser(u), token, deviceToken: device_ };
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
