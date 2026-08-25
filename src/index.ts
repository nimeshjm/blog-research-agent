import type { Env, ResearchParams } from './lib/types';
import { ATTR_INSTANCE_ID, traced } from './lib/trace';

export { ResearchWorkflow } from './workflow';

/**
 * Cron only starts a Workflow instance; all orchestration lives in the
 * Workflow so each step gets its own CPU budget. Keep this handler trivial -
 * the free plan allows 10 ms of CPU per cron invocation.
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
