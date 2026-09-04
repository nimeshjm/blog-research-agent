/**
 * Word tokenizer shared by `proposeTopic`'s dedupe check
 * (src/propose-workflow.ts) and `relevanceScore`'s topic-overlap scoring
 * (src/workflow.ts). Moved here rather than duplicated once a second caller
 * existed (#109, `ProposeWorkflow`) - REVIEW.md pass 5's "duplicated ...
 * logic that belongs in src/lib". Neither caller may import the other's
 * file (a child Workflow file never imports from src/workflow.ts, and vice
 * versa - see gather-workflow.ts/summarize-workflow.ts/publish-workflow.ts),
 * so this had to live somewhere both can reach without a cycle.
 */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'is', 'are',
  'with', 'how', 'why', 'what', 'this', 'that', 'from', 'at', 'by', 'as',
  'it', 'its', 'be', 'we', 'you', 'your', 'new', 'v1', 'vs',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}
