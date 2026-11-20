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
it('uses the configured cadence after a completed pass and never overlaps refresh with an in-flight pass', async () => {
  vi.useFakeTimers();
  const settings = structuredClone(defaultSettings); settings.monitoring.enabled = true;
  let finish!: (value: { ran: boolean }) => void;
  const run = vi.fn(() => new Promise<{ ran: boolean }>(resolve => { finish = resolve; }));
  const scheduler = createMonitorScheduler(() => settings, run);
  scheduler.refresh();
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(run).toHaveBeenCalledTimes(1);
  scheduler.refresh();
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(run).toHaveBeenCalledTimes(1);
  finish({ ran: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(settings.monitoring.intervalMinutes * 60_000);
  expect(run).toHaveBeenCalledTimes(2);
  finish({ ran: false });
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(run).toHaveBeenCalledTimes(3);
  scheduler.stop(); vi.useRealTimers();
});
it('wakes at the earliest retry deadline even when idle cadence is longer', async () => {
  vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-01-01'));
  const settings = structuredClone(defaultSettings); settings.monitoring.enabled = true; settings.monitoring.intervalMinutes = 5;
  const run = vi.fn().mockImplementation(() => Promise.resolve({ ran: false, nextAttemptAt: Date.now() + 60_000 }));
  const scheduler = createMonitorScheduler(() => settings, run);
  scheduler.refresh();
  await vi.advanceTimersByTimeAsync(300_000);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(2);
  scheduler.stop(); vi.useRealTimers();
});
it('promptly rechecks an explicit deadline that elapsed before scheduling', async () => {
  vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-01-01'));
  const settings = structuredClone(defaultSettings); settings.monitoring.enabled = true;
  let calls = 0;
  const run = vi.fn(async () => {
    if (++calls !== 1) return { ran: false };
    const nextAttemptAt = Date.now() + 1_000;
    vi.setSystemTime(Date.now() + 2_000);
    return { ran: false, nextAttemptAt };
  });
  const scheduler = createMonitorScheduler(() => settings, run);
  try {
    scheduler.refresh(); await vi.advanceTimersByTimeAsync(300_000);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
  } finally { scheduler.stop(); vi.useRealTimers(); }
});
it('does not rearm after stop while an attempt is in flight', async () => {
  vi.useFakeTimers();
  const settings = structuredClone(defaultSettings); settings.monitoring.enabled = true;
  let finish!: (value: { ran: boolean }) => void;
  const run = vi.fn(() => new Promise<{ ran: boolean }>(resolve => { finish = resolve; }));
  const scheduler = createMonitorScheduler(() => settings, run);
  scheduler.refresh(); await vi.advanceTimersByTimeAsync(settings.monitoring.intervalMinutes * 60_000);
  scheduler.stop(); finish({ ran: true }); await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(run).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});
it('drains current work before close and ignores repeated signals', async () => {
  const order: string[] = [];
  const stop = createShutdown({ stopTimer: () => { order.push('stop'); }, quiesce: () => { order.push('quiesce'); }, awaitSettled: async () => { order.push('drain'); }, close: async () => { order.push('close'); }, exit: () => { order.push('exit'); } });
  stop('SIGINT'); stop('SIGTERM'); await vi.waitFor(() => expect(order).toEqual(['stop', 'quiesce', 'drain', 'close', 'exit']));
});
