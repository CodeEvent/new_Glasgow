import { execFile } from 'child_process';

/**
 * Phone health for the Android (Termux) setup: alerts when the phone is unplugged or the
 * battery runs low, so the bot doesn't die silently during an event. Uses
 * `termux-battery-status` (Termux:API); does nothing anywhere else.
 */

export interface Battery {
  percentage: number;
  plugged: string; // "UNPLUGGED", "PLUGGED_AC", "PLUGGED_USB", …
}

export function readTermuxBattery(): Promise<Battery | null> {
  return new Promise((resolve, reject) => {
    // Without the Termux:API app this command hangs, hence the timeout.
    execFile('termux-battery-status', { timeout: 15_000 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const j = JSON.parse(stdout);
        resolve(typeof j.percentage === 'number' ? { percentage: j.percentage, plugged: String(j.plugged ?? '') } : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/** Decides which alerts a new reading deserves (pure, for testing). */
export function batteryAlerts(prev: { unplugged?: boolean; low?: boolean }, b: Battery): { alerts: string[]; state: { unplugged: boolean; low: boolean } } {
  const unplugged = b.plugged === 'UNPLUGGED';
  const low = b.percentage <= 20 || (prev.low === true && b.percentage <= 30); // re-arm above 30%
  const alerts: string[] = [];
  if (unplugged && !prev.unplugged) alerts.push(`🔌 The Gatekeeper phone is *unplugged* (${b.percentage}%). Plug it in so the bot keeps running.`);
  if (!unplugged && prev.unplugged) alerts.push(`🔌 The Gatekeeper phone is charging again (${b.percentage}%).`);
  if (low && !prev.low) alerts.push(`🪫 The Gatekeeper phone battery is at *${b.percentage}%*.${unplugged ? ' Plug it in now.' : ''}`);
  return { alerts, state: { unplugged, low } };
}

export function startHealthJob(
  alert: (text: string) => void,
  read: () => Promise<Battery | null> = readTermuxBattery,
  everyMs = 5 * 60_000,
): () => void {
  let state: { unplugged?: boolean; low?: boolean } = {};
  let failures = 0;
  let handle: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (handle) clearInterval(handle);
    handle = null;
  };
  const tick = async () => {
    try {
      const b = await read();
      if (!b) return;
      failures = 0;
      const r = batteryAlerts(state, b);
      state = r.state;
      for (const a of r.alerts) alert(a);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return stop(); // not on Termux, or termux-api not installed: nothing to watch
      if (++failures === 3) {
        console.warn('[health] battery status unavailable (install the Termux:API app for battery alerts); stopping checks');
        stop();
      }
    }
  };
  handle = setInterval(() => void tick(), everyMs);
  (handle as { unref?: () => void }).unref?.();
  void tick();
  return stop;
}
