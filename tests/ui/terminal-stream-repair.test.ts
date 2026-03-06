import { describe, expect, it } from 'vitest';

import {
  shouldScheduleTerminalStreamRepair,
  STREAM_REPAIR_COOLDOWN_MS,
  STREAM_REPAIR_LATENCY_THRESHOLD_MS,
  STREAM_REPAIR_THRESHOLD_BYTES
} from '../../src/lib/terminalStreamRepair';

describe('terminal stream repair scheduling', () => {
  it('schedules repair after sustained streamed output while following', () => {
    expect(
      shouldScheduleTerminalStreamRepair({
        autoFollow: true,
        bytesSinceLastRepair: STREAM_REPAIR_THRESHOLD_BYTES,
        lastQueueLatencyMs: 0,
        lastRepairAtMs: 0,
        nowMs: STREAM_REPAIR_COOLDOWN_MS + 10
      })
    ).toBe(true);
  });

  it('schedules repair when queue latency stays elevated', () => {
    expect(
      shouldScheduleTerminalStreamRepair({
        autoFollow: true,
        bytesSinceLastRepair: 512,
        lastQueueLatencyMs: STREAM_REPAIR_LATENCY_THRESHOLD_MS,
        lastRepairAtMs: 0,
        nowMs: STREAM_REPAIR_COOLDOWN_MS + 10
      })
    ).toBe(true);
  });

  it('does not schedule repair while follow is paused', () => {
    expect(
      shouldScheduleTerminalStreamRepair({
        autoFollow: false,
        bytesSinceLastRepair: STREAM_REPAIR_THRESHOLD_BYTES * 2,
        lastQueueLatencyMs: STREAM_REPAIR_LATENCY_THRESHOLD_MS * 2,
        lastRepairAtMs: 0,
        nowMs: STREAM_REPAIR_COOLDOWN_MS + 10
      })
    ).toBe(false);
  });

  it('does not reschedule repair inside the cooldown window', () => {
    expect(
      shouldScheduleTerminalStreamRepair({
        autoFollow: true,
        bytesSinceLastRepair: STREAM_REPAIR_THRESHOLD_BYTES * 2,
        lastQueueLatencyMs: STREAM_REPAIR_LATENCY_THRESHOLD_MS * 2,
        lastRepairAtMs: 500,
        nowMs: 500 + STREAM_REPAIR_COOLDOWN_MS - 1
      })
    ).toBe(false);
  });
});
