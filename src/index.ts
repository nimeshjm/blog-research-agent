import type { Env, ResearchParams } from './lib/types';
import { ATTR_INSTANCE_ID, traced } from './lib/trace';

export { ResearchWorkflow } from './workflow';
export { GatherWorkflow } from './gather-workflow';
export { SummarizeWorkflow } from './summarize-workflow';
export { PublishWorkflow } from './publish-workflow';

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
