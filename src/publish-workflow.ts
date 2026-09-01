import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  createBranch,
  openPullRequest as githubOpenPullRequest,
  putFile,
  readBaseRefSha,
  readRepoFile,
} from './lib/github';
import type { GithubConfig } from './lib/github';
import { blogPostPath, renderMdx, validateAgainstContentConfig, validateDraft } from './lib/mdx';
import type { Draft, Env, PublishParams } from './lib/types';
import { tracerFor } from './lib/trace';

/**
 * feature 003's third child instance (spec.md requirement 2, extended
 * 2026-09-01 (#75) after run `0357f119` reached the last step and died in
 * it). The run gathered 1,118 candidates from all 46 feeds, shortlisted,
 * summarised in three children and produced a real draft - and then
 * `open-pull-request` failed with the platform's own `Too many subrequests by
 * single Worker invocation.` Its seven GitHub calls were the parent's residue
 * against 50, and this class is where they are spent instead: a child is a
 * separate Workflow instance with its own `run()` and its own 50-subrequest
 * budget, the same reason `GatherWorkflow` and `SummarizeWorkflow` exist.
 *
 * **A third class rather than one child parameterised over all three jobs.**
 * The binding is `Workflow<TParams>`, so one class would mean one binding
 * carrying a union params type and a union return type the parent has to
 * narrow before it can validate either half - `createBatch` and each
 * `validate` stay monomorphic this way. Same argument `SummarizeWorkflow`
 * made when it became the second.
 *
 * **The whole publication is one step, not seven.** A child has 50
 * subrequests to itself, so there is nothing to buy by splitting the schema
 * read, the ref read, the branch create, the file commit and the pull request
 * across five step boundaries - and an all-or-nothing step is the shape the
 * idempotency argument is easiest to hold: every write below delegates to
 * `src/lib/github.ts`'s own idempotent primitives, so this step is safe to
 * run twice whether the second run is a replay of the same instance or a
 * later run that derived the same branch name (`createBranch`'s comment has
 * both cases).
 *
 * The body is `runPublish`, a plain function, for the same reason `runGather`
 * and `runSummarize` are: `WorkflowEntrypoint`'s real constructor rejects
 * being `new`'d outside the platform's own Workflows runtime, so `run()`
 * itself is untestable in isolation.
 */
export async function runPublish(env: Env, step: WorkflowStep, event: WorkflowEvent<PublishParams>): Promise<string> {
  const traceStep = tracerFor(step, event);

  // The step name is the same `open-pull-request` literal the parent used to
  // carry, moved here unchanged - it is the replay key, and keeping it
  // identical is what makes a trace of this run comparable with every run
  // before it. The URL it returns stays out of every span attribute
  // (CLAUDE.md) and rides the step output instead.
  return traceStep('open-pull-request', {}, async () => openPullRequest(env, event.payload.draft));
}

export class PublishWorkflow extends WorkflowEntrypoint<Env, PublishParams> {
  run(event: WorkflowEvent<PublishParams>, step: WorkflowStep): Promise<string> {
    return runPublish(this.env, step, event);
  }
}

/**
 * Validates frontmatter (statically, then against the blog's live
 * `content.config.ts`), creates `research/<yyyy-mm-dd>-<slug>`, commits
 * `src/content/blog/<slug>/index.mdx`, opens the PR with the brief as its
 * body. Moved here unchanged from `src/workflow.ts` when publication became a
 * child instance (plan.md, "Reuse"), except for this comment's own
 * cross-references.
 *
 * Idempotent end to end, and none of the mechanism is reimplemented here:
 * `createBranch` confirms an existing ref rather than assuming a 422 means
 * one, `putFile` reads the file's current sha on the branch first, and
 * `githubOpenPullRequest` reuses an open PR for the same head. Each of those
 * doc comments carries its own mechanism; this function's contribution is
 * only that it calls them in an order where a second run of the whole thing
 * converges on the same single pull request.
 *
 * **Seven subrequests, which is what moving this into a child bought.** One
 * `readRepoFile`, one `readBaseRefSha`, one `createBranch` POST, `putFile`'s
 * sha read and PUT, and `githubOpenPullRequest`'s list-then-POST. An eighth
 * is spent only on the exceptional path, where `createBranch`'s 422 sends it
 * to `refExists`. All of it inside a child's own 50 rather than whatever the
 * parent had left.
 *
 * The agent never pushes to `BLOG_BASE_BRANCH`: `prParams.base` below is the
 * only read of it, inline inside a `base:` property so
 * `base-branch-not-a-write-target` can prove that structurally, and it is
 * only ever passed to `readBaseRefSha` (a GET) and as the PR's `base` field
 * - never to `createBranch` or `putFile`, which are what could write to it.
 * Nor does this file spell out a fully-qualified ref path anywhere, comments
 * included: that check flags the co-occurrence, not the write, and
 * `src/lib/github.ts`'s header explains why the ref-path literal lives with
 * the primitive rather than with the caller that knows the base branch's name.
 */
export async function openPullRequest(env: Env, draft: Draft): Promise<string> {
  validateDraft(draft);

  const config: GithubConfig = { apiBase: env.GITHUB_API_BASE, token: env.GITHUB_TOKEN, repo: env.BLOG_REPO };

  // Dynamic check against the live schema - spec.md: "the PR step reads it
  // ... rather than trusting the copy above, so a schema change upstream
  // surfaces as a failed step instead of a broken build." A missing schema
  // file is itself surfaced the same way (readRepoFile returns null here
  // only on 404; any other failure already threw inside it).
  const schemaSource = await readRepoFile(config, 'src/content.config.ts');
  if (schemaSource === null) {
    throw new Error('openPullRequest: src/content.config.ts not found in the blog repo - cannot validate frontmatter');
  }
  validateAgainstContentConfig(schemaSource);

  const prParams = {
    title: draft.title,
    body: draft.brief,
    head: `research/${draft.date}-${draft.slug}`,
    base: env.BLOG_BASE_BRANCH,
  };

  const baseSha = await readBaseRefSha(config, prParams.base);
  await createBranch(config, prParams.head, baseSha); // idempotent: an existing ref is confirmed, not assumed

  await putFile(config, {
    path: blogPostPath(draft.slug),
    content: renderMdx(draft),
    message: `Add research draft: ${draft.title}`,
    branch: prParams.head,
  }); // idempotent: reads the file's current sha on that branch first

  return githubOpenPullRequest(config, prParams); // idempotent: reuses an existing open PR for this head
}
