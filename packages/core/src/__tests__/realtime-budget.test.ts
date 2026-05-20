/**
 * Tests for the v0.9.81 time-budget infrastructure:
 *   - Bridge soft-deadline timer fires + injects reminders at T-120s / T-30s.
 *   - extend_call_time honours per-request, per-call, and total caps.
 *   - schedule_callback validates delay window, summary, and one-per-call.
 *   - Grace window ends the bridge if the agent doesn't act.
 *
 * All time-dependent assertions use an INJECTED clock + setTimeout/clearTimeout
 * so a "1 hour" call test runs in microseconds.
 */
import { describe, expect, it } from 'vitest';
import {
  RealtimeVoiceBridge,
  buildRealtimeSessionConfig,
  CALL_BUDGET_GRACE_SECONDS,
  type RealtimeBridgePort,
  type ScheduledCallbackRequest,
} from '../phone/realtime-bridge.js';

class FakePort implements RealtimeBridgePort {
  sent: Record<string, unknown>[] = [];
  closed = false;
  send(m: Record<string, unknown>): void { this.sent.push(m); }
  close(): void { this.closed = true; }
}

/**
 * Manual clock + manual timer scheduler. `tick(ms)` advances the clock
 * and synchronously fires every timer whose deadline has passed,
 * in deadline-asc order. Mirrors vitest's `useFakeTimers` but
 * scoped to just the bridge — keeps the test deterministic and
 * makes the sequence of fires obvious in failure messages.
 */
class FakeScheduler {
  private clock = 1_700_000_000_000; // any fixed reference; arithmetic is what matters
  private nextId = 1;
  private timers = new Map<number, { fireAt: number; cb: () => void }>();

  now = (): number => this.clock;
  setTimeout = ((cb: () => void, ms: number): any => {
    const id = this.nextId++;
    this.timers.set(id, { fireAt: this.clock + ms, cb });
    return id;
  }) as unknown as typeof setTimeout;
  clearTimeout = ((id: any): void => {
    this.timers.delete(id as number);
  }) as unknown as typeof clearTimeout;

  /** Advance the clock by `ms` and fire every timer whose deadline elapses. */
  tick(ms: number): void {
    this.clock += ms;
    const due: Array<{ id: number; fireAt: number; cb: () => void }> = [];
    for (const [id, t] of this.timers.entries()) {
      if (t.fireAt <= this.clock) due.push({ id, ...t });
    }
    due.sort((a, b) => a.fireAt - b.fireAt);
    for (const t of due) {
      this.timers.delete(t.id);
      try { t.cb(); } catch { /* tests assert behaviour, not throws here */ }
    }
  }
}

function helloFrame() {
  return { t: 'hello', callid: 'call-1', from: '+12025550100', to: '+12125550100' };
}

interface SetupOpts {
  budgetSeconds: number;
  extension?: { maxSecondsPerRequest: number; maxRequestsPerCall: number; maxTotalExtensionSeconds: number };
  callback?: { allowAutoCallback: boolean; maxCallbackChain: number };
  callbackSink?: (req: ScheduledCallbackRequest) => void;
}

function setup(opts: SetupOpts) {
  const scheduler = new FakeScheduler();
  const elks = new FakePort();
  const openai = new FakePort();
  const callbacks: ScheduledCallbackRequest[] = [];
  const bridge = new RealtimeVoiceBridge({
    elks,
    openai,
    sessionConfig: buildRealtimeSessionConfig({ task: 'budget test' }),
    callBudgetSeconds: opts.budgetSeconds,
    extensionPolicy: opts.extension,
    callbackPolicy: opts.callback,
    onCallbackScheduled: (req) => {
      callbacks.push(req);
      opts.callbackSink?.(req);
    },
    now: scheduler.now,
    setTimeoutFn: scheduler.setTimeout,
    clearTimeoutFn: scheduler.clearTimeout,
  });
  // Bring the bridge to "live call" state.
  bridge.handleOpenAIOpen();
  bridge.handleCarrierMessage(helloFrame());
  return { bridge, openai, elks, scheduler, callbacks };
}

/** Count the system messages injected into the OpenAI port. */
function countInjections(openai: FakePort): number {
  return openai.sent.filter((m) => {
    if (m.type !== 'conversation.item.create') return false;
    const item = m.item as { role?: string };
    return item?.role === 'system';
  }).length;
}

describe('RealtimeVoiceBridge — call budget (v0.9.81)', () => {
  it('reports the configured budget as time remaining right after hello', () => {
    const { bridge } = setup({ budgetSeconds: 300 });
    expect(bridge.getTimeRemainingSeconds()).toBeGreaterThanOrEqual(299);
    expect(bridge.getTimeRemainingSeconds()).toBeLessThanOrEqual(300);
  });

  it('returns Infinity when no budget was configured (legacy mode)', () => {
    const scheduler = new FakeScheduler();
    const bridge = new RealtimeVoiceBridge({
      elks: new FakePort(),
      openai: new FakePort(),
      sessionConfig: buildRealtimeSessionConfig({ task: 'legacy' }),
      now: scheduler.now,
      setTimeoutFn: scheduler.setTimeout,
      clearTimeoutFn: scheduler.clearTimeout,
    });
    expect(bridge.getTimeRemainingSeconds()).toBe(Number.POSITIVE_INFINITY);
  });

  it('injects the T-120s reminder once when the call passes the 2-minute-remaining mark', () => {
    const { bridge, openai, scheduler } = setup({ budgetSeconds: 300 });
    const before = countInjections(openai);
    // 180 seconds elapsed = 120s left → T-120s mark fires.
    scheduler.tick(180_000);
    expect(countInjections(openai)).toBe(before + 1);
    expect(bridge.getTimeRemainingSeconds()).toBeLessThanOrEqual(120);
  });

  it('injects the T-30s reminder distinctly after the T-120s one', () => {
    const { openai, scheduler } = setup({ budgetSeconds: 300 });
    scheduler.tick(180_000); // T-120s fires
    const after120 = countInjections(openai);
    scheduler.tick(90_000); // 270s elapsed = 30s left → T-30s fires
    expect(countInjections(openai)).toBe(after120 + 1);
  });

  it('after the soft deadline, ends the call when the grace window elapses', () => {
    const ends: string[] = [];
    const scheduler = new FakeScheduler();
    const elks = new FakePort();
    const openai = new FakePort();
    const bridge = new RealtimeVoiceBridge({
      elks, openai,
      sessionConfig: buildRealtimeSessionConfig({ task: 'budget end' }),
      callBudgetSeconds: 60,
      onEnd: ({ reason, endedByTimeBudget }) => ends.push(`${reason}|${endedByTimeBudget ? 'budget' : 'other'}`),
      now: scheduler.now,
      setTimeoutFn: scheduler.setTimeout,
      clearTimeoutFn: scheduler.clearTimeout,
    });
    bridge.handleOpenAIOpen();
    bridge.handleCarrierMessage(helloFrame());
    scheduler.tick(60_000);                  // soft deadline fires
    expect(bridge.isEnded).toBe(false);     // still inside the grace window
    scheduler.tick(CALL_BUDGET_GRACE_SECONDS * 1000 + 100); // grace elapses
    expect(bridge.isEnded).toBe(true);
    expect(ends[0]).toBe('time-budget-exceeded|budget');
  });
});

describe('RealtimeVoiceBridge — extend_call_time', () => {
  const pol = { maxSecondsPerRequest: 120, maxRequestsPerCall: 2, maxTotalExtensionSeconds: 300 };

  it('grants the requested seconds within all three caps', () => {
    const { bridge } = setup({ budgetSeconds: 60, extension: pol });
    const r = bridge.extendCallTime(60, 'caller wants 1 more minute');
    expect(r.granted).toBe(true);
    expect(r.secondsGranted).toBe(60);
    expect(bridge.getTimeRemainingSeconds()).toBeGreaterThanOrEqual(119);
  });

  it('caps a single request at maxSecondsPerRequest even when room is available', () => {
    const { bridge } = setup({ budgetSeconds: 60, extension: pol });
    const r = bridge.extendCallTime(999, 'optimistic');
    expect(r.granted).toBe(true);
    expect(r.secondsGranted).toBe(120); // per-request cap
  });

  it('refuses once maxRequestsPerCall is exhausted', () => {
    const { bridge } = setup({ budgetSeconds: 60, extension: pol });
    expect(bridge.extendCallTime(30).granted).toBe(true);
    expect(bridge.extendCallTime(30).granted).toBe(true);
    const r = bridge.extendCallTime(30);
    expect(r.granted).toBe(false);
    expect(r.message).toMatch(/Out of extensions/);
    expect(r.extensionsRemaining).toBe(0);
  });

  it('refuses extension when no policy is configured', () => {
    const { bridge } = setup({ budgetSeconds: 60 });
    const r = bridge.extendCallTime(60);
    expect(r.granted).toBe(false);
    expect(r.message).toMatch(/not enabled/);
  });

  it('refuses negative or zero requests', () => {
    const { bridge } = setup({ budgetSeconds: 60, extension: pol });
    expect(bridge.extendCallTime(0).granted).toBe(false);
    expect(bridge.extendCallTime(-30).granted).toBe(false);
  });

  it('an accepted extension pushes the soft deadline AND re-arms reminders', () => {
    const { bridge, scheduler, openai } = setup({ budgetSeconds: 180, extension: pol });
    // T-120 fires at 60s elapsed.
    scheduler.tick(60_000);
    const injectionsAfterFirstReminder = countInjections(openai);
    // Extend by 2 min → soft deadline pushes from t=180 to t=300.
    // Now at clock=60s, deadline=300s → 240s remaining.
    expect(bridge.extendCallTime(120, 'need more time').granted).toBe(true);
    expect(bridge.getTimeRemainingSeconds()).toBeGreaterThanOrEqual(239);
    // Tick to 180s elapsed (120s remaining post-extension). T-120 was
    // already fired before extension; the dedup set prevents a second fire.
    scheduler.tick(120_000);
    expect(countInjections(openai)).toBe(injectionsAfterFirstReminder);
  });
});

describe('RealtimeVoiceBridge — schedule_callback', () => {
  const allowed = { allowAutoCallback: true, maxCallbackChain: 2 };

  it('persists the request via onCallbackScheduled with a computed `at`', () => {
    const { bridge, callbacks } = setup({ budgetSeconds: 60, callback: allowed });
    const r = bridge.scheduleCallback({
      delaySeconds: 1800,
      reason: 'caller asked me to ring back later',
      summary: 'caller wants the booking moved to next Tuesday at 7pm. They confirmed party of 4.',
    });
    expect(r.accepted).toBe(true);
    expect(callbacks.length).toBe(1);
    expect(callbacks[0].agentSummary).toMatch(/party of 4/);
    expect(callbacks[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('rejects a delay below the 30s floor', () => {
    const { bridge } = setup({ budgetSeconds: 60, callback: allowed });
    const r = bridge.scheduleCallback({ delaySeconds: 5, reason: 'too soon', summary: 'x' });
    expect(r.accepted).toBe(false);
    expect(r.message).toMatch(/30s/);
  });

  it('rejects a delay above the 7-day ceiling', () => {
    const { bridge } = setup({ budgetSeconds: 60, callback: allowed });
    const r = bridge.scheduleCallback({
      delaySeconds: 30 * 24 * 60 * 60, // a month
      reason: 'far',
      summary: 'x',
    });
    expect(r.accepted).toBe(false);
  });

  it('rejects an empty summary', () => {
    const { bridge } = setup({ budgetSeconds: 60, callback: allowed });
    const r = bridge.scheduleCallback({ delaySeconds: 60, reason: '', summary: '   ' });
    expect(r.accepted).toBe(false);
    expect(r.message).toMatch(/summary/);
  });

  it('only one callback per call — the second is refused', () => {
    const { bridge } = setup({ budgetSeconds: 60, callback: allowed });
    expect(bridge.scheduleCallback({ delaySeconds: 60, reason: '', summary: 'one' }).accepted).toBe(true);
    expect(bridge.scheduleCallback({ delaySeconds: 60, reason: '', summary: 'two' }).accepted).toBe(false);
  });

  it('refuses scheduling when the callback policy is missing OR disabled', () => {
    const { bridge: noPol } = setup({ budgetSeconds: 60 });
    expect(noPol.scheduleCallback({ delaySeconds: 60, reason: '', summary: 'x' }).accepted).toBe(false);
    const { bridge: disabled } = setup({
      budgetSeconds: 60,
      callback: { allowAutoCallback: false, maxCallbackChain: 0 },
    });
    expect(disabled.scheduleCallback({ delaySeconds: 60, reason: '', summary: 'x' }).accepted).toBe(false);
  });
});

describe('RealtimeVoiceBridge — endByAgentRequest (v0.9.82)', () => {
  it('drops the call when the agent calls end_call', () => {
    const ends: { reason: string; endedByTimeBudget?: boolean }[] = [];
    const scheduler = new FakeScheduler();
    const elks = new FakePort();
    const openai = new FakePort();
    const bridge = new RealtimeVoiceBridge({
      elks, openai,
      sessionConfig: buildRealtimeSessionConfig({ task: 'end test' }),
      callBudgetSeconds: 600,
      onEnd: (s) => ends.push({ reason: s.reason, endedByTimeBudget: s.endedByTimeBudget }),
      now: scheduler.now,
      setTimeoutFn: scheduler.setTimeout,
      clearTimeoutFn: scheduler.clearTimeout,
    });
    bridge.handleOpenAIOpen();
    bridge.handleCarrierMessage(helloFrame());
    expect(bridge.isEnded).toBe(false);

    const result = bridge.endByAgentRequest('caller said goodbye');
    expect(result.ok).toBe(true);
    expect(bridge.isEnded).toBe(true);
    // onEnd ran exactly once with the agent-requested reason. The
    // endedByTimeBudget flag stays false (agent end, not budget end).
    expect(ends).toEqual([{ reason: 'agent-requested', endedByTimeBudget: undefined }]);
    // Both ports were closed.
    expect(openai.closed).toBe(true);
    expect(elks.closed).toBe(true);
  });

  it('is idempotent — a second end_call returns ok: false', () => {
    const { bridge } = setup({ budgetSeconds: 60 });
    expect(bridge.endByAgentRequest('first').ok).toBe(true);
    expect(bridge.endByAgentRequest('second').ok).toBe(false);
  });
});

describe('RealtimeVoiceBridge — getCallStatus', () => {
  it('reports remaining time + extension envelope + callback availability', () => {
    const { bridge } = setup({
      budgetSeconds: 300,
      extension: { maxSecondsPerRequest: 120, maxRequestsPerCall: 2, maxTotalExtensionSeconds: 240 },
      callback: { allowAutoCallback: true, maxCallbackChain: 1 },
    });
    const status = bridge.getCallStatus();
    expect(status.secondsRemaining).toBeGreaterThan(299);
    expect(status.extension.extensionsRemaining).toBe(2);
    expect(status.extension.maxSecondsPerRequest).toBe(120);
    expect(status.callbackAvailable).toBe(true);
    expect(status.callbackArmed).toBe(false);
  });

  it('flips callbackArmed to true after a successful scheduleCallback', () => {
    const { bridge } = setup({
      budgetSeconds: 60,
      callback: { allowAutoCallback: true, maxCallbackChain: 1 },
    });
    bridge.scheduleCallback({ delaySeconds: 60, reason: '', summary: 'x' });
    expect(bridge.getCallStatus().callbackArmed).toBe(true);
    expect(bridge.isCallbackArmed).toBe(true);
  });
});
