/** Self-serve checklist when emoji reactions do nothing. */
export function reactionsSetupChecklist(): string {
  return (
    '*Emoji reactions need extra Slack app setup* (code is deployed; @mention works without this).\n\n' +
    '1. *api.slack.com/apps* → your app → *Event Subscriptions*\n' +
    '   • Request URL: `https://scintel-slack-bot.ghanesh-balaji1995.workers.dev/slack/events` (green ✓)\n' +
    '   • *Subscribe to bot events* must include: `reaction_added`\n\n' +
    '2. *OAuth & Permissions* → *Bot Token Scopes* must include:\n' +
    '   • `reactions:read` ← required or Slack never sends reaction events\n' +
    '   • `channels:history` (public channels)\n' +
    '   • `groups:history` (private channels)\n' +
    '   • existing: `chat:write`, `app_mentions:read`, …\n\n' +
    '3. *Install App* → *Reinstall to Workspace* after changing scopes/events\n\n' +
    '4. In the channel: `/invite @YourBotName`\n\n' +
    '5. Test: post a message, react `:rocket:` on it\n' +
    '   • `:rocket:` = create PR · `:mag:` = review/Q&A\n\n' +
    'If still silent, run `/ask-code reactions` again after reinstall — we log `reaction_added` in worker logs when events arrive.'
  );
}
