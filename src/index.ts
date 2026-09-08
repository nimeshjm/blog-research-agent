import type { Env, ResearchParams, ReviewSweepParams } from './lib/types';
import { ATTR_INSTANCE_ID, traced } from './lib/trace';

export { ResearchWorkflow } from './workflow';
export { GatherWorkflow } from './gather-workflow';
export { SummarizeWorkflow } from './summarize-workflow';
export { PublishWorkflow } from './publish-workflow';
export { ProposeWorkflow } from './propose-workflow';
export { ReviewSweepWorkflow } from './review-sweep-workflow';

/**
 * Cron only starts a Workflow instance; all orchestration lives in the
 * Workflow because a cron invocation is capped at 15 minutes of wall-clock and
 * a Workflow step is not. CPU is 10 ms per invocation on either side and a step
 * boundary is not a fresh budget, so the Workflow buys wall-clock, not CPU.
 * Keep this handler trivial.
 *
 * `create()` is wrapped in a span via `traced()` from `src/lib/trace.ts` -
 * this file never imports `tracing` itself. The instance id is only known
 * once `create()` resolves, so it is set on the span handed to the body
 * rather than passed in up front. This is what links the auto-traced
 * `Scheduled Handler` span to the Workflow run it started.
 */
export default {
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    // The only decision this handler makes: which instance to start. #116's
    // sweep gets its own cron slot rather than a loop over a cron-to-binding
    // map, because `scheduled-stays-thin` forbids a loop (or a fetch, a D1
    // call, an env.AI.run, or a step.do) inside this function - an `if` is
    // the only shape a second trigger can take here.
    if (controller.cron === env.REVIEW_SWEEP_CRON) {
      const sweepParams: ReviewSweepParams = {
        triggeredAt: new Date(controller.scheduledTime).toISOString(),
      };
      await traced('review-sweep-workflow-create', {}, async (span) => {
        const instance = await env.REVIEW_SWEEP_WORKFLOW.create({ params: sweepParams });
        span.setAttribute(ATTR_INSTANCE_ID, instance.id);
        console.log(`review-sweep-workflow started: ${instance.id}`);
      });
      return;
    }

    // `env.REVIEW_SWEEP_CRON` must equal the second entry of `crons` in
    // wrangler.toml verbatim - both literals live in that one file, adjacent,
    // so drift is visible in one place. If they ever diverge, every slot
    // takes this research branch instead: an extra research run a day, which
    // acceptance criterion 8's daily neuron guard absorbs as a
    // `budget_skipped` row, and the sweep silently never runs. That is the
    // failure this pairing is chosen to make cheap to notice rather than
    // impossible - `review-sweep-cron-matches-trigger`
    // (scripts/review-checks.mjs) is what notices it.
    const params: ResearchParams = {
      triggeredAt: new Date(controller.scheduledTime).toISOString(),
    };
    await traced('research-workflow-create', {}, async (span) => {
      const instance = await env.RESEARCH_WORKFLOW.create({ params });
      span.setAttribute(ATTR_INSTANCE_ID, instance.id);
      console.log(`research-workflow started: ${instance.id}`);
    });
  },
} satisfies ExportedHandler<Env>;
