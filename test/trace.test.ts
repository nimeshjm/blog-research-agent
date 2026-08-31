import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { tracedStep, tracerFor } from '../src/lib/trace';

/**
 * The retry policy is the point of these cases: `spec.md` requirement 1 of
 * feature 003 says no step is retried, and `src/lib/trace.ts` is the only
 * `step.do` call site there is (`rules/no-bare-step-do.yml`), so asserting
 * what reaches `step.do` from here asserts it for every step in the Worker.
 *
 * The fake never invokes the callback, so nothing here depends on `tracing`
 * being live in the test runtime - what is under test is the arguments, not
 * the span.
 */
function recordingStep(): { step: WorkflowStep; calls: Array<{ name: string; config: unknown }> } {
  const calls: Array<{ name: string; config: unknown }> = [];
  const step = {
    do(name: string, config: unknown, _callback?: unknown) {
      calls.push({ name, config });
      return Promise.resolve(undefined);
    },
  } as unknown as WorkflowStep;
  return { step, calls };
}

describe('tracedStep', () => {
  it('passes a zero-retry policy to step.do', async () => {
    const { step, calls } = recordingStep();

    await tracedStep(step, 'gather:Some Feed', {}, async () => undefined);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.config).toEqual({ retries: { limit: 0, delay: 0 } });
  });

  // The real `summarize:` name carries a candidate URL; the scheme is dropped
  // here only so this file adds no `no-hardcoded-urls` warnings of its own.
  it('still passes the step name through byte-identical', async () => {
    const { step, calls } = recordingStep();

    await tracedStep(step, 'summarize:example.com/a?x=1', {}, async () => undefined);

    expect(calls[0]?.name).toBe('summarize:example.com/a?x=1');
  });
});

describe('tracerFor', () => {
  it('carries the same policy through the bound tracer', async () => {
    const { step, calls } = recordingStep();
    const event = { instanceId: 'abc', workflowName: 'research-workflow' } as WorkflowEvent<unknown>;

    await tracerFor(step, event)('select-topic', {}, async () => undefined);

    expect(calls[0]?.config).toEqual({ retries: { limit: 0, delay: 0 } });
  });
});
