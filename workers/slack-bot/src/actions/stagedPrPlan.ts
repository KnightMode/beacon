import type { Env } from '../env.js';

export interface StagedPlanInput {
  tenantId?: string;
  repoId: string;
  repoFullName: string;
  channel: string;
  threadTs: string;
  userId?: string;
  issue: string;
}

export interface StagedPlan {
  id: string;
  title: string;
  summary: string;
}

const BREAKING_CHANGE_RE =
  /\b(breaking|cross[-\s]?repo|multi[-\s]?repo|migration|migrate all|all consumers|downstream|dependenc(?:y|ies)|major version|api change|schema change)\b/i;

export function needsStagedPrPlan(issue: string, indexedContext: string): boolean {
  void indexedContext;
  return BREAKING_CHANGE_RE.test(issue);
}

export async function createStagedPrPlan(
  env: Env,
  input: StagedPlanInput,
): Promise<StagedPlan> {
  const planId = crypto.randomUUID();
  const title = titleFor(input.issue);
  const impact = {
    issue: input.issue,
    repo: input.repoFullName,
    reason:
      'Detected breaking/cross-repo migration language; using staged PR chain instead of one large PR.',
  };

  await env.DB.prepare(
    `INSERT INTO staged_pr_plans
       (id, tenant_id, repo_id, source_channel, source_thread_ts, title, status,
        impact_json, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'PLANNED', ?7, ?8)`,
  )
    .bind(
      planId,
      input.tenantId ?? null,
      input.repoId,
      input.channel,
      input.threadTs,
      title,
      JSON.stringify(impact),
      input.userId ?? null,
    )
    .run();

  const steps = stagedSteps(input.repoId);
  for (const [i, step] of steps.entries()) {
    await env.DB.prepare(
      `INSERT INTO staged_pr_steps
         (id, plan_id, step_order, repo_id, title, status,
          depends_on_step_ids_json, validation_json, rollback_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
      .bind(
        crypto.randomUUID(),
        planId,
        i + 1,
        input.repoId,
        step.title,
        i === 0 ? 'READY' : 'PENDING',
        JSON.stringify(step.dependsOn),
        JSON.stringify(step.validation),
        JSON.stringify(step.rollback),
      )
      .run();
  }

  return {
    id: planId,
    title,
    summary: formatStagedPlan(title, planId),
  };
}

function titleFor(issue: string): string {
  const first = issue.split('\n').map((s) => s.trim()).find(Boolean) ?? 'Staged migration';
  return first.length > 96 ? `${first.slice(0, 93)}...` : first;
}

function stagedSteps(repoId: string): Array<{
  title: string;
  dependsOn: string[];
  validation: string[];
  rollback: string[];
}> {
  return [
    {
      title: `Add backward-compatible change in ${repoId}`,
      dependsOn: [],
      validation: ['typecheck', 'unit tests', 'affected package build'],
      rollback: ['revert compatibility shim PR'],
    },
    {
      title: 'Migrate first downstream consumer with tests',
      dependsOn: ['1'],
      validation: ['consumer unit tests', 'integration smoke test'],
      rollback: ['revert consumer migration PR'],
    },
    {
      title: 'Migrate remaining affected consumers in dependency order',
      dependsOn: ['2'],
      validation: ['repo-specific CI checks', 'cross-repo contract checks'],
      rollback: ['revert failed consumer PR only'],
    },
    {
      title: 'Remove deprecated compatibility path after all consumers pass',
      dependsOn: ['3'],
      validation: ['full provider CI', 'no remaining references in Zoekt/SCIP search'],
      rollback: ['restore compatibility path'],
    },
  ];
}

function formatStagedPlan(title: string, planId: string): string {
  return [
    `Created staged PR plan *${title}* (${planId}).`,
    '',
    '1. Add a backward-compatible provider change first.',
    '2. Migrate one downstream consumer and validate it.',
    '3. Migrate the remaining consumers in dependency order.',
    '4. Remove the deprecated path only after references are gone.',
    '',
    'I did not open one giant PR because this looks like a breaking or cross-repo change.',
  ].join('\n');
}
