import { describe, it, expect } from 'vitest';
import { buildFtsMatch } from '../src/retrieval/lexical.js';
import { parseQuery } from '../src/retrieval/queryUnderstanding.js';
import { parsePlannerOutput } from '../src/retrieval/agent.js';
import { detectIntent, parseIndexRepoTarget } from '../src/intent.js';
import { scopeAllowlist } from '../src/retrieval/pipeline.js';
import { citedMarkers } from '../src/format.js';

const REPOS = [
  'knightmode/slack-code-intelligence',
  'knightmode/aim',
  'spf13/viper',
];

describe('scopeAllowlist', () => {
  it('scopes to a repo named in the question', () => {
    expect(scopeAllowlist('how does viper work eli5', REPOS)).toEqual([
      'spf13/viper',
    ]);
  });

  it('scopes on explicit owner/name', () => {
    expect(scopeAllowlist('explain spf13/viper config layering', REPOS)).toEqual(
      ['spf13/viper'],
    );
  });

  it('matches hyphenated repo names spoken with spaces', () => {
    expect(
      scopeAllowlist('how does slack code intelligence chunk markdown?', REPOS),
    ).toEqual(['knightmode/slack-code-intelligence']);
  });

  it('keeps all repos when none are mentioned', () => {
    expect(scopeAllowlist('where is the webhook signature verified?', REPOS)).toEqual(
      REPOS,
    );
  });
});

describe('citedMarkers', () => {
  it('collects the markers used in the answer', () => {
    expect(citedMarkers('Viper layers config [6][7], see also [2].')).toEqual(
      new Set([2, 6, 7]),
    );
  });

  it('is empty when no markers appear', () => {
    expect(citedMarkers('No citations here.').size).toBe(0);
  });
});

describe('index intents', () => {
  it('detects "index owner/repo"', () => {
    expect(detectIntent('index KnightMode/some-repo')).toBe('index_repo');
    expect(detectIntent('add repo KnightMode/some-repo')).toBe('index_repo');
    expect(detectIntent('Index the repository foo/bar')).toBe('index_repo');
    expect(parseIndexRepoTarget('index KnightMode/some-repo')).toBe(
      'KnightMode/some-repo',
    );
  });

  it('detects "index status"', () => {
    expect(detectIntent('index status')).toBe('index_status');
    expect(detectIntent('indexing status')).toBe('index_status');
  });

  it('does not hijack ordinary questions', () => {
    expect(detectIntent('how does the indexer chunk markdown?')).toBe('qa');
    expect(detectIntent('where is the index used in retrieval?')).toBe('qa');
    expect(detectIntent('review https://github.com/o/r/pull/1')).toBe('pr_review');
    expect(detectIntent('create pr: add docs')).toBe('create_pr');
  });
});

describe('buildFtsMatch', () => {
  it('quotes needles as prefix phrases joined with OR', () => {
    const match = buildFtsMatch(parseQuery('where is verifySlackSignature used'));
    expect(match).toContain('"verifySlackSignature"*');
    expect(match.split(' OR ').length).toBeGreaterThan(1);
  });

  it('escapes double quotes inside needles', () => {
    const match = buildFtsMatch({
      raw: '',
      symbols: ['foo"bar'],
      terms: [],
      intent: 'general',
    });
    expect(match).toBe('"foo""bar"*');
  });

  it('returns empty string when there is nothing to search', () => {
    const match = buildFtsMatch({
      raw: '',
      symbols: [],
      terms: [],
      intent: 'general',
    });
    expect(match).toBe('');
  });

  it('caps the number of needles at 10', () => {
    const terms = Array.from({ length: 25 }, (_, i) => `term${i}xx`);
    const match = buildFtsMatch({ raw: '', symbols: [], terms, intent: 'general' });
    expect(match.split(' OR ').length).toBe(10);
  });
});

describe('parsePlannerOutput', () => {
  it('parses a done decision', () => {
    expect(parsePlannerOutput('{"done": true}')).toEqual({ done: true, tools: [] });
  });

  it('parses tool requests', () => {
    const out = parsePlannerOutput(
      '{"done": false, "tools": [{"tool":"search","query":"webhook hmac"},' +
        '{"tool":"callers","symbol":"verifySlackSignature"}]}',
    );
    expect(out).toEqual({
      done: false,
      tools: [
        { tool: 'search', query: 'webhook hmac' },
        { tool: 'callers', symbol: 'verifySlackSignature' },
      ],
    });
  });

  it('tolerates fences and surrounding prose', () => {
    const out = parsePlannerOutput(
      'Sure, here is my decision:\n```json\n{"done": false, "tools": [' +
        '{"tool":"read_file","repo":"o/r","path":"src/a.ts","start_line":1,"end_line":50}]}\n```',
    );
    expect(out?.tools).toEqual([
      { tool: 'read_file', repo: 'o/r', path: 'src/a.ts', start_line: 1, end_line: 50 },
    ]);
  });

  it('drops unknown or malformed tools but keeps valid ones', () => {
    const out = parsePlannerOutput(
      '{"done": false, "tools": [{"tool":"rm_rf"},{"tool":"search","query":""},' +
        '{"tool":"callees","symbol":"retrieve"}]}',
    );
    expect(out?.tools).toEqual([{ tool: 'callees', symbol: 'retrieve' }]);
  });

  it('caps tools per turn at 3', () => {
    const tools = Array.from(
      { length: 6 },
      (_, i) => `{"tool":"search","query":"q${i}"}`,
    ).join(',');
    const out = parsePlannerOutput(`{"done": false, "tools": [${tools}]}`);
    expect(out?.tools.length).toBe(3);
  });

  it('returns null on garbage', () => {
    expect(parsePlannerOutput('I could not decide.')).toBeNull();
    expect(parsePlannerOutput('{not json}')).toBeNull();
    expect(parsePlannerOutput('')).toBeNull();
  });
});
