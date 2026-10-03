import { Jimp, loadFont } from 'jimp';
import { SANS_64_BLACK } from 'jimp/fonts';
import { afterAll, describe, expect, it } from 'vitest';
import { readSeatsFromImage, seatsFromText, stopOcr } from '../src/services/ticketOcr';

const s = (section: string, row: string, seat: string) => ({ section, row, seat });

describe('finding seats in ticket text', () => {
  it('reads a header line followed by the values', () => {
    expect(seatsFromText('SECTION   ROW   SEAT\n313       YY    56')).toEqual([s('313', 'YY', '56')]);
    expect(seatsFromText('Sec Row Seat\n 313  yy  56 \nGeneral Admission')).toEqual([s('313', 'YY', '56')]);
  });

  it('reads labelled seats on one line, with lists and ranges', () => {
    expect(seatsFromText('Sec 313 · Row YY · Seat 56')).toEqual([s('313', 'YY', '56')]);
    expect(seatsFromText('BLOCK 313 ROW YY SEATS 56-58')).toEqual([s('313', 'YY', '56'), s('313', 'YY', '57'), s('313', 'YY', '58')]);
    expect(seatsFromText('Section: 223, Row: Y, Seat: 100, 101')).toEqual([s('223', 'Y', '100'), s('223', 'Y', '101')]);
  });

  it('finds several tickets, across rows, without repeats', () => {
    const screen = 'SECTION ROW SEAT\n313 YY 56\nSECTION ROW SEAT\n313 YY 57\nSec 313 Row ZZ Seat 10\nSec 313 Row YY Seat 56';
    expect(seatsFromText(screen)).toEqual([s('313', 'YY', '56'), s('313', 'YY', '57'), s('313', 'ZZ', '10')]);
  });

  it('reads seat fields in a QR payload', () => {
    expect(seatsFromText('TM|EVT123|SEC:313|ROW:YY|SEAT:56')).toEqual([s('313', 'YY', '56')]);
  });

  it('ignores text without seats', () => {
    expect(seatsFromText('Doors 18:30 · Show 20:00 · Gate 3 · Row of lights')).toEqual([]);
    expect(seatsFromText('')).toEqual([]);
  });
});

describe('real OCR on a ticket image', () => {
  afterAll(async () => {
    await stopOcr();
  });

  it('reads the seat printed on a generated ticket', async () => {
    const font = await loadFont(SANS_64_BLACK);
    const img = new Jimp({ width: 1100, height: 320, color: 0xffffffff });
    img.print({ font, x: 40, y: 40, text: 'SECTION   ROW   SEAT' });
    img.print({ font, x: 40, y: 170, text: '313        YY      56' });
    const seats = await readSeatsFromImage(await img.getBuffer('image/png'));
    expect(seats).toContainEqual(s('313', 'YY', '56'));
  }, 120_000);
});
