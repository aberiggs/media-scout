import { expect, it, vi } from 'vitest';
import { createMonitorScheduler, createShutdown } from '../src/daemon';
import { defaultSettings } from '../src/settings';
it('does not schedule when disabled and stops scheduling on shutdown', async () => {
  vi.useFakeTimers();
  const settings = structuredClone(defaultSettings), run = vi.fn(async () => {});
  const scheduler = createMonitorScheduler(() => settings, run);
  scheduler.refresh(); await vi.advanceTimersByTimeAsync(600_000); expect(run).not.toHaveBeenCalled();
  settings.monitoring.enabled = true; scheduler.refresh(); await vi.advanceTimersByTimeAsync(300_000); expect(run).toHaveBeenCalledTimes(1);
  scheduler.stop(); await vi.advanceTimersByTimeAsync(600_000); expect(run).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});
it('drains current work before close and ignores repeated signals', async () => {
  const order: string[] = [];
  const stop = createShutdown({ stopTimer: () => { order.push('stop'); }, awaitSettled: async () => { order.push('drain'); }, close: async () => { order.push('close'); }, exit: () => { order.push('exit'); } });
  stop('SIGINT'); stop('SIGTERM'); await vi.waitFor(() => expect(order).toEqual(['stop', 'drain', 'close', 'exit']));
});
