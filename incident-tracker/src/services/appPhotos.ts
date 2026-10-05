import { getPool, withTransaction } from '../db/pool';
import { audit } from './accounts';
import { emitAppEvent } from './appFeed';
import { can, type AppUser } from './permissions';

/**
 * Photos of the person or the ticket, added from the app. Anyone logged in can add one (it helps the
 * next gate recognise someone); seniors and the superadmin can delete them. They're deleted with
 * the record (RETENTION) and never sent anywhere else.
 */

export class PhotoError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_PER_RECORD = 6;

export interface PhotoInfo {
  id: string;
  kind: 'person' | 'ticket';
  at: string;
  by: string | null;
}

async function recordSeat(ticketId: string): Promise<string> {
  const { rows } = await getPool().query<{ ticket_id: string; section: string | null; row_label: string | null; seat_number: string | null }>(
    'SELECT ticket_id, section, row_label, seat_number FROM tickets WHERE ticket_id = $1',
    [ticketId.slice(0, 64)],
  );
  if (!rows[0]) throw new PhotoError('That record isn’t there any more.', 404);
  const r = rows[0];
  return r.section ? `${r.section} ${r.row_label} ${r.seat_number}` : r.ticket_id;
}

export async function addPhoto(user: AppUser, ticketId: string, kindIn: unknown, data: unknown, mime: string): Promise<PhotoInfo> {
  const kind = String(kindIn ?? 'person');
  if (kind !== 'person' && kind !== 'ticket') throw new PhotoError('Photo of the person or the ticket.');
  const type = mime.split(';')[0].trim().toLowerCase();
  if (!(PHOTO_TYPES as readonly string[]).includes(type)) throw new PhotoError('Photos must be JPEG, PNG or WebP.', 415);
  if (!Buffer.isBuffer(data) || !data.length) throw new PhotoError('Send the photo.');
  if (data.length > MAX_PHOTO_BYTES) throw new PhotoError('That photo is too big (5 MB at most).', 413);
  const seat = await recordSeat(ticketId);
  // Count and add in one step, with the record locked, so photos sent at once can't pass the limit.
  const rows = await withTransaction(async (client) => {
    const locked = await client.query('SELECT 1 FROM tickets WHERE ticket_id = $1 FOR UPDATE', [ticketId]);
    if (!locked.rowCount) throw new PhotoError('That record isn’t there any more.', 404);
    const { rows: count } = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM ticket_photos WHERE ticket_id = $1', [ticketId]);
    if (count[0].n >= MAX_PER_RECORD) throw new PhotoError(`This record already has ${MAX_PER_RECORD} photos.`, 409);
    return (
      await client.query<{ id: string; created_at: Date }>(
        'INSERT INTO ticket_photos (ticket_id, mime_type, data, kind, user_id, added_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at',
        [ticketId, type, data, kind, user.id, user.name],
      )
    ).rows;
  });
  await audit(user, 'photo_added', `${seat} (${kind})`);
  emitAppEvent({ kind: 'change', seat, what: 'edited', by: user.name });
  return { id: rows[0].id, kind, at: new Date(rows[0].created_at).toISOString(), by: user.name };
}

export async function listPhotos(ticketId: string): Promise<PhotoInfo[]> {
  await recordSeat(ticketId);
  const { rows } = await getPool().query<{ id: string; kind: 'person' | 'ticket'; created_at: Date; added_by: string | null }>(
    'SELECT id, kind, created_at, added_by FROM ticket_photos WHERE ticket_id = $1 ORDER BY created_at DESC, id DESC',
    [ticketId],
  );
  return rows.map((r) => ({ id: r.id, kind: r.kind, at: new Date(r.created_at).toISOString(), by: r.added_by }));
}

const validId = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

export async function getPhoto(id: string): Promise<{ data: Buffer; mime: string }> {
  if (!validId(id)) throw new PhotoError('Not found.', 404);
  const { rows } = await getPool().query<{ data: Buffer; mime_type: string }>('SELECT data, mime_type FROM ticket_photos WHERE id = $1', [id]);
  if (!rows[0]) throw new PhotoError('Not found.', 404);
  // Only real image types are served as images (older WhatsApp photos kept whatever type the sender claimed).
  const mime = /^image\/(jpeg|png|webp|gif)$/i.test(rows[0].mime_type) ? rows[0].mime_type.toLowerCase() : 'application/octet-stream';
  return { data: rows[0].data, mime };
}

export async function deletePhoto(user: AppUser, id: string): Promise<void> {
  if (!can(user, 'delete')) throw new PhotoError('Only senior supervisors can delete photos.', 403);
  if (!validId(id)) throw new PhotoError('Not found.', 404);
  const { rows } = await getPool().query<{ ticket_id: string }>('DELETE FROM ticket_photos WHERE id = $1 RETURNING ticket_id', [id]);
  if (!rows[0]) throw new PhotoError('Not found.', 404);
  const seat = await recordSeat(rows[0].ticket_id).catch(() => rows[0].ticket_id);
  await audit(user, 'photo_deleted', seat);
  emitAppEvent({ kind: 'change', seat, what: 'edited', by: user.name });
}
