import { getSetting, setSetting } from '../channels/pgAuthState';

/**
 * Options stewards (or the AI) add on the fly: a reason, height or build that isn't on the fixed
 * lists is accepted and offered next time as a numbered option, after the fixed ones. Kept in
 * app_settings so it survives restarts; never duplicated (case-insensitive).
 */

export type OptionKind = 'reasons' | 'heights' | 'builds';
export type CustomOptions = Record<OptionKind, string[]>;

const KEY = 'custom_options';
const LABEL: Record<OptionKind, string> = { reasons: 'reasons', heights: 'heights', builds: 'builds' };
let current: CustomOptions = { reasons: [], heights: [], builds: [] };

/** The added options as last loaded (the bot refreshes them on every message). */
export const customOptions = (): CustomOptions => current;

export async function refreshCustomOptions(): Promise<CustomOptions> {
  try {
    const stored = await getSetting<Partial<CustomOptions> | null>(KEY, null);
    current = { reasons: stored?.reasons ?? [], heights: stored?.heights ?? [], builds: stored?.builds ?? [] };
  } catch {
    /* keep what we had: the database may be briefly unavailable */
  }
  return current;
}

/** "  TRESPASSING " -> "Trespassing"; null if it doesn't look like a short label. */
export function cleanTerm(text: string): string | null {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.length < 3 || t.length > 30) return null;
  if (t.split(' ').length > 3) return null; // a sentence, not an option
  if (!/^[\p{L}][\p{L}\p{N} '’-]*$/u.test(t)) return null;
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

/**
 * Adds a term (unless it's already there, ignoring case, or among `fixed`).
 * Returns the term to use and whether it was new.
 */
// Adds run one at a time, so two stewards adding the same word at once can't both add it.
let queue: Promise<unknown> = Promise.resolve();

export function addCustomOption(kind: OptionKind, term: string, fixed: readonly string[]): Promise<{ term: string; added: boolean }> {
  const run = queue.then(() => addNow(kind, term, fixed));
  queue = run.catch(() => undefined);
  return run;
}

async function addNow(kind: OptionKind, term: string, fixed: readonly string[]): Promise<{ term: string; added: boolean }> {
  const same = (a: string) => a.toLowerCase() === term.toLowerCase();
  const existing = fixed.find(same) ?? current[kind].find(same);
  if (existing) return { term: existing, added: false };
  await refreshCustomOptions();
  const again = current[kind].find(same);
  if (again) return { term: again, added: false };
  current = { ...current, [kind]: [...current[kind], term] };
  await setSetting(KEY, current);
  return { term, added: true };
}

export async function removeCustomOption(term: string): Promise<OptionKind | null> {
  await refreshCustomOptions();
  for (const kind of Object.keys(current) as OptionKind[]) {
    const i = current[kind].findIndex((t) => t.toLowerCase() === term.trim().toLowerCase());
    if (i >= 0) {
      current = { ...current, [kind]: current[kind].filter((_, j) => j !== i) };
      await setSetting(KEY, current);
      return kind;
    }
  }
  return null;
}

export const kindLabel = (kind: OptionKind) => LABEL[kind];
