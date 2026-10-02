import { getConfig } from '../config/env';
import type { IncidentStatus, LoggedAction } from '../domain';

export function formatClock(d: Date | string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: getConfig().TZ_DISPLAY,
  }).format(new Date(d));
}

/** Whole minutes from `from` to `to`, never negative. */
export function minutesBetween(from: Date | string, to: Date | string): number {
  return Math.max(0, Math.floor((new Date(to).getTime() - new Date(from).getTime()) / 60_000));
}

/** Minutes remaining until `until`, rounded up so "0" only appears once it has truly expired. */
export function minutesUntil(until: Date | string, now: Date | string = new Date()): number {
  return Math.max(0, Math.ceil((new Date(until).getTime() - new Date(now).getTime()) / 60_000));
}

export function agoLabel(mins: number): string {
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m ago`;
}

export function statusLabel(status: IncidentStatus): string {
  switch (status) {
    case 'cooling_off':
      return '🟠 COOLING OFF';
    case 'completely_refused':
      return '🔴 COMPLETELY REFUSED';
    case 'admitted':
      return '🟢 ADMITTED';
  }
}

export function actionLabel(action: LoggedAction, steward: string): string {
  switch (action) {
    case 'initial_cool_off':
      return `Initial Cool-Off Applied by ${steward}.`;
    case 'initial_refusal':
      return `Entry Refused by ${steward}.`;
    case 'bypass_attempt':
      return `🚨 Bypass Attempt Intercepted by ${steward} (Blocked).`;
    case 'unauthorized_admission':
      return `🚨 UNAUTHORIZED ADMISSION by ${steward} (BREACH).`;
    case 'cleared_admission':
      return `Admitted after cool-off expired by ${steward}.`;
    case 'repeat_scan':
      return `Re-scanned by ${steward}.`;
  }
}

export function partyLabel(n: number): string {
  return `${n} ${n === 1 ? 'Person' : 'People'}`;
}

export function mapsLink(lat: number | string | null | undefined, lng: number | string | null | undefined): string | null {
  if (lat === null || lat === undefined || lng === null || lng === undefined) return null;
  return `https://maps.google.com/?q=${lat},${lng}`;
}

/** Remove WhatsApp formatting control characters from user-supplied text so it cannot break layout. */
export function sanitize(text: string, max = 500): string {
  const clean = text.replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
