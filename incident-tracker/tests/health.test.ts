import { describe, expect, it } from 'vitest';
import { batteryAlerts, startHealthJob, type Battery } from '../src/services/health';

describe('phone health alerts', () => {
  it('alerts once when unplugged, once when charging again, and once when low', () => {
    let state = {};
    const step = (b: Battery) => {
      const r = batteryAlerts(state, b);
      state = r.state;
      return r.alerts;
    };
    expect(step({ percentage: 80, plugged: 'PLUGGED_AC' })).toEqual([]);
    expect(step({ percentage: 79, plugged: 'UNPLUGGED' })[0]).toContain('*unplugged* (79%)');
    expect(step({ percentage: 60, plugged: 'UNPLUGGED' })).toEqual([]);
    const low = step({ percentage: 20, plugged: 'UNPLUGGED' });
    expect(low).toHaveLength(1);
    expect(low[0]).toContain('*20%*. Plug it in now.');
    expect(step({ percentage: 18, plugged: 'UNPLUGGED' })).toEqual([]); // no repeats
    expect(step({ percentage: 25, plugged: 'PLUGGED_USB' })).toEqual(['🔌 The Gatekeeper phone is charging again (25%).']);
    expect(step({ percentage: 35, plugged: 'PLUGGED_USB' })).toEqual([]); // low re-armed above 30%
    expect(step({ percentage: 19, plugged: 'PLUGGED_USB' })[0]).toContain('🪫');
  });

  it('stops quietly where there is no battery reader', async () => {
    const alerts: string[] = [];
    let calls = 0;
    const missing = Object.assign(new Error('not found'), { code: 'ENOENT' });
    const stop = startHealthJob((a) => alerts.push(a), async () => (calls++, Promise.reject(missing)), 10);
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(calls).toBe(1);
    expect(alerts).toEqual([]);
  });
});
