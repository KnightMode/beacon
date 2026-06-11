/**
 * Per-repo CI-triage notification channels: "@bot notify owner/repo here"
 * maps an indexed repo to the Slack channel that receives its CI-failure
 * triage posts. Repos without a mapping are never posted about.
 */

import type { Env } from './env.js';

/** Registers the mapping and returns the Slack reply text. */
export async function setNotifyChannel(
  env: Env,
  repoRef: string,
  channelId: string,
  addedBy?: string,
): Promise<string> {
  const repoId = repoRef.toLowerCase();
  const row = await env.DB.prepare(
    `SELECT r.full_name
     FROM prototype_repo_allowlist a
     JOIN repos r ON r.id = a.repo_id
     WHERE a.repo_id = ?1 AND a.enabled = 1`,
  )
    .bind(repoId)
    .first<{ full_name: string }>();
  if (!row) {
    return (
      `:no_entry: \`${repoRef}\` isn't indexed yet — say \`index ${repoRef}\` ` +
      'first, then register CI notifications.'
    );
  }

  await env.DB.prepare(
    `INSERT INTO ci_notify_channels (repo_id, channel_id, added_by)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(repo_id) DO UPDATE SET
       channel_id = excluded.channel_id,
       added_by = excluded.added_by`,
  )
    .bind(repoId, channelId, addedBy ?? null)
    .run();

  return (
    `:bell: CI-failure triage for *${row.full_name}* will be posted to ` +
    `<#${channelId}>. When a GitHub Actions run fails I'll analyze it there — ` +
    'react :rocket: on a triage message to have me draft a fix PR. ' +
    '(Make sure I am invited to the channel.)'
  );
}

export async function getNotifyChannel(
  env: Env,
  repoId: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT channel_id FROM ci_notify_channels WHERE repo_id = ?1`,
  )
    .bind(repoId)
    .first<{ channel_id: string }>();
  return row?.channel_id ?? null;
}
