import { getSetting, setSetting } from '../channels/pgAuthState';
import { getPool } from '../db/pool';
import { listRecords } from './adminRecords';

/**
 * Seating map for the records page: an uploaded plan image (kept in this database only)
 * plus where each block sits on it, as fractions of the image size (0..1), so markers
 * stay in place at any screen size. Counts come from tonight's records.
 */

export const MAP_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const MAX_MAP_BYTES = 10 * 1024 * 1024;
const BLOCKS_KEY = 'map_blocks';

export type BlockPositions = Record<string, { x: number; y: number }>;

export interface SectionCounts {
  refused: number;
  ejected: number;
  away: number; // sent away, cool-off still running
  ended: number; // cool-off ended
  cleared: number;
  total: number;
  seats: string[]; // "YY 56"
}

export async function getMapImage(): Promise<{ data: Buffer; mime: string } | null> {
  const { rows } = await getPool().query<{ data: Buffer; mime_type: string }>('SELECT data, mime_type FROM venue_map WHERE id = 1');
  return rows[0] ? { data: Buffer.from(rows[0].data), mime: rows[0].mime_type } : null;
}

export async function hasMapImage(): Promise<boolean> {
  const { rows } = await getPool().query('SELECT 1 FROM venue_map WHERE id = 1');
  return rows.length > 0;
}

export async function setMapImage(data: Buffer, mime: string): Promise<void> {
  await getPool().query(
    `INSERT INTO venue_map (id, mime_type, data) VALUES (1, $1, $2)
     ON CONFLICT (id) DO UPDATE SET mime_type = EXCLUDED.mime_type, data = EXCLUDED.data, updated_at = TIMEZONE('utc'::text, NOW())`,
    [mime, data],
  );
}

export const getBlocks = () => getSetting<BlockPositions>(BLOCKS_KEY, {});

/** Block names look like sections: "313", "BB", "A12". */
export function validBlock(block: unknown): block is string {
  return typeof block === 'string' && /^[A-Za-z0-9]{1,6}$/.test(block.trim());
}

export async function setBlock(block: string, x: number, y: number): Promise<BlockPositions> {
  const blocks = await getBlocks();
  blocks[block.trim().toUpperCase()] = { x: Math.round(x * 10_000) / 10_000, y: Math.round(y * 10_000) / 10_000 };
  await setSetting(BLOCKS_KEY, blocks);
  return blocks;
}

export async function deleteBlock(block: string): Promise<BlockPositions> {
  const blocks = await getBlocks();
  delete blocks[block.trim().toUpperCase()];
  await setSetting(BLOCKS_KEY, blocks);
  return blocks;
}

/** Tonight's records grouped by section (= block on the map). */
export async function sectionCounts(now = new Date()): Promise<Record<string, SectionCounts>> {
  const out: Record<string, SectionCounts> = {};
  for (const r of await listRecords({}, 10_000)) {
    if (!r.section) continue;
    const key = r.section.replace(/\s+/g, '').toUpperCase();
    const c = (out[key] ??= { refused: 0, ejected: 0, away: 0, ended: 0, cleared: 0, total: 0, seats: [] });
    if (r.current_status === 'admitted') c.cleared++;
    else if (r.current_status === 'completely_refused') /^Ejected/.test(r.reasoning) ? c.ejected++ : c.refused++;
    else if (r.cool_down_until && new Date(r.cool_down_until) > now) c.away++;
    else c.ended++;
    c.total++;
    c.seats.push(`${r.row_label} ${r.seat_number}`);
  }
  return out;
}
