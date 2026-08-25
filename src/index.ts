import type { Env, ResearchParams } from './lib/types';

export { ResearchWorkflow } from './workflow';

/**
 * Cron only starts a Workflow instance; all orchestration lives in the
 * Workflow so each step gets its own CPU budget. Keep this handler trivial -
 * the free plan allows 10 ms of CPU per cron invocation.
 */
export default {
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const params: ResearchParams = {
      triggeredAt: new Date(controller.scheduledTime).toISOString(),
    };
    const instance = await env.RESEARCH_WORKFLOW.create({ params });
    console.log(`research-workflow started: ${instance.id}`);
  },
} satisfies ExportedHandler<Env>;
