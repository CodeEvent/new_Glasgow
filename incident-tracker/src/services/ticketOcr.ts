import { createWorker, PSM, type Worker } from 'tesseract.js';

/**
 * Reads section / row / seat from a photo or screenshot of a ticket, on this device
 * (Tesseract, English data bundled with the npm package: nothing is sent anywhere).
 * Ticketmaster's mobile QR codes are encrypted and rotate, so the printed seat is the
 * reliable source; QR payloads that do carry seat fields go through seatsFromText too.
 */

export interface SeatRef {
  section: string;
  row: string;
  seat: string;
}

const MAX_SEATS = 20;
const SECTION = '([A-Z]{0,3}\\d{1,4}[A-Z]{0,2})';
const ROW = '([A-Z]{1,3}|\\d{1,3})';
const SEATS = '(\\d{1,4}(?:\\s*(?:[-–,&]|and)\\s*\\d{1,4})*)';
const LABELLED = new RegExp(
  `(?:SEC(?:TION)?|BLOCK|BLK)\\W{0,3}${SECTION}\\W{1,8}ROW\\W{0,3}${ROW}\\W{1,8}SEATS?\\W{0,3}${SEATS}`,
  'gi',
);
const HEADER = /\b(?:SEC(?:TION)?|BLOCK|BLK)\b\W+\bROW\b\W+\bSEATS?\b/i;
const VALUES = new RegExp(`^\\W*${SECTION}\\W+${ROW}\\W+${SEATS}\\W*$`, 'i');

/** "56-58" -> 56,57,58; "100, 101" -> 100,101. */
function expandSeats(list: string): string[] {
  const out: string[] = [];
  for (const part of list.split(/\s*(?:,|&|\band\b)\s*/i)) {
    const r = /^(\d{1,4})\s*[-–]\s*(\d{1,4})$/.exec(part.trim());
    if (r && Number(r[2]) > Number(r[1]) && Number(r[2]) - Number(r[1]) <= 50) {
      for (let n = Number(r[1]); n <= Number(r[2]); n++) out.push(String(n));
    } else if (/^\d{1,4}$/.test(part.trim())) {
      out.push(part.trim());
    }
  }
  return out;
}

/** Every seat mentioned in OCR (or QR) text, in order, without repeats. */
export function seatsFromText(text: string): SeatRef[] {
  const found: SeatRef[] = [];
  const add = (section: string, row: string, seats: string) => {
    for (const seat of expandSeats(seats)) {
      const s = { section: section.toUpperCase(), row: row.toUpperCase(), seat };
      if (found.length < MAX_SEATS && !found.some((f) => f.section === s.section && f.row === s.row && f.seat === s.seat)) found.push(s);
    }
  };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    // "SECTION ROW SEAT" on one line, the values on the next non-empty line.
    if (HEADER.test(lines[i]) && !new RegExp(LABELLED.source, 'i').test(lines[i])) {
      const next = lines.slice(i + 1).find((l) => l.trim());
      const v = next ? VALUES.exec(next.trim()) : null;
      if (v) add(v[1], v[2], v[3]);
      continue;
    }
    for (const m of lines[i].matchAll(LABELLED)) add(m[1], m[2], m[3]);
  }
  return found;
}

// ---------------------------------------------------------------- OCR worker

let worker: Promise<Worker> | null = null;

function getWorker(): Promise<Worker> {
  if (!worker) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const eng = require('@tesseract.js-data/eng') as { langPath: string; gzip: boolean };
    worker = createWorker('eng', 1, { langPath: eng.langPath, gzip: eng.gzip, cacheMethod: 'none' }).then(async (w) => {
      await w.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: '1' });
      return w;
    });
    worker.catch(() => {
      worker = null; // try again next time
    });
  }
  return worker;
}

/** Seats printed on a ticket image; [] if none could be read (or OCR failed). */
export async function readSeatsFromImage(image: Buffer, timeoutMs = 60_000): Promise<SeatRef[]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const w = await getWorker();
    const result = await Promise.race([
      w.recognize(image),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('OCR timed out')), timeoutMs);
      }),
    ]);
    return seatsFromText(result.data.text ?? '');
  } catch (err) {
    console.error('[ocr] could not read the ticket:', (err as Error).message);
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Frees the OCR worker (shutdown, tests). */
export async function stopOcr(): Promise<void> {
  const w = worker;
  worker = null;
  if (w) await (await w).terminate();
}
