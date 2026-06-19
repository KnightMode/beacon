import { describe, it, expect } from 'vitest';
import { buildFtsMatch } from '../src/retrieval/lexical.js';
import { parseQuery } from '../src/retrieval/queryUnderstanding.js';
import { parsePlannerOutput, shouldRunPlanner } from '../src/retrieval/agent.js';
import { detectIntent, parseIndexRepoTarget } from '../src/intent.js';
import { needsStagedPrPlan } from '../src/actions/stagedPrPlan.js';
import { scopeAllowlist } from '../src/retrieval/pipeline.js';
import { buildZoektQuery, normalizeZoektResponse } from '../src/retrieval/zoekt.js';
import { packContext } from '../src/retrieval/pack.js';
import { rerank } from '../src/retrieval/rerank.js';
import { citedMarkers } from '../src/format.js';
import { getAllowlistedRepoIds } from '../src/allowlist.js';
import { buildRetrievalText } from '../src/history.js';
import { stripAbstentionCitations } from '../src/llm.js';
import type { RetrievedChunk } from '@scintel/shared';

const REPOS = [
  'knightmode/slack-code-intelligence',
  'knightmode/aim',
  'spf13/viper',
  'knightmode/ebpf-wiremock-router',
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

  it('matches partial repo aliases like "ebpf report"', () => {
    expect(scopeAllowlist('explain the ebpf report', REPOS)).toEqual([
      'knightmode/ebpf-wiremock-router',
    ]);
  });

  it('keeps all repos when none are mentioned', () => {
    expect(scopeAllowlist('where is the webhook signature verified?', REPOS)).toEqual(
      REPOS,
    );
  });
});

describe('buildRetrievalText', () => {
  it('includes the previous assistant answer so "this" resolves to mentioned symbols', () => {
    const text = buildRetrievalText(
      [
        { role: 'user', text: 'explain the ebpf report' },
        {
          role: 'assistant',
          text:
            'The class is `EbpfTestReport` in `EbpfTestReport.java`.\n\n*Sources*\n[1] beacon/irrelevant.ts:1-2',
        },
      ],
      'which files import this then',
    );

    expect(text).toContain('explain the ebpf report');
    expect(text).toContain('EbpfTestReport.java');
    expect(text).toContain('which files import this then');
    expect(text).not.toContain('beacon/irrelevant.ts');
  });
});

describe('tenant allowlist fallback', () => {
  it('does not use the prototype allowlist for an unknown Slack workspace', async () => {
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({ first: async () => null }),
          all: async () => {
            throw new Error('prototype allowlist should not be queried');
          },
        }),
      },
    };

    await expect(getAllowlistedRepoIds(env as never, 'T_UNKNOWN')).resolves.toEqual([]);
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

describe('packContext', () => {
  it('preserves retrieval source on citations for eval attribution', () => {
    const packed = packContext([
      {
        id: 'c1',
        repoId: 'knightmode/beacon',
        repoFullName: 'KnightMode/beacon',
        path: 'workers/slack-bot/src/retrieval/zoekt.ts',
        language: 'typescript',
        chunkType: 'function',
        symbol: 'zoektSearch',
        startLine: 1,
        endLine: 20,
        content: 'export async function zoektSearch() {}',
        commitSha: 'abc',
        score: 0.9,
        source: 'zoekt',
      },
    ]);

    expect(packed.citations[0]?.source).toBe('zoekt');
    expect(packed.citations[0]?.sources).toEqual(['zoekt']);
    expect(packed.contextText).toContain('retrieved by zoekt');
  });
});

describe('rerank', () => {
  it('promotes chunks that are backed by code-intel sources', () => {
    const parsed = parseQuery('How are Zoekt search hits hydrated?');
    const vector = chunk({
      id: 'same',
      source: 'vector',
      score: 0.9,
      path: 'workers/slack-bot/src/retrieval/zoekt.ts',
    });
    const zoekt = chunk({
      id: 'same',
      source: 'zoekt',
      score: 0.75,
      path: 'workers/slack-bot/src/retrieval/zoekt.ts',
    });
    const lexical = chunk({
      id: 'other',
      source: 'lexical',
      score: 1.1,
      path: 'workers/slack-bot/src/retrieval/pipeline.ts',
    });

    const ranked = rerank(parsed, [[vector], [zoekt], [lexical]], 2);

    expect(ranked[0]?.id).toBe('same');
    expect(ranked[0]?.sources).toEqual(['vector', 'zoekt']);
  });

  it('does not promote unrelated code-intel chunks solely by source', () => {
    const parsed = parseQuery('How does the indexer chunk markdown files?');
    const scip = chunk({
      id: 'scip-noise',
      source: 'scip',
      score: 0.95,
      path: 'workers/slack-bot/src/stream.ts',
    });
    const markdown = chunk({
      id: 'markdown',
      source: 'lexical',
      score: 0.9,
      path: 'services/indexer/src/chunking/markdownChunker.ts',
    });

    const ranked = rerank(parsed, [[scip], [markdown]], 2);

    expect(ranked[0]?.id).toBe('markdown');
  });
});

describe('buildZoektQuery', () => {
  it('uses high-signal parsed terms instead of the raw natural-language question', () => {
    const query = buildZoektQuery(
      parseQuery('How are Zoekt search hits converted into Beacon retrieval context and citations?'),
    );

    expect(query).toBe('Zoekt or hits or retrieval or context or citations');
    expect(query).not.toContain('How are');
  });

  it('keeps explicit symbols and path-like terms searchable', () => {
    const query = buildZoektQuery(
      parseQuery('How does `ZOEKT_SEARCH_URL` connect to workers/slack-bot/wrangler.toml?'),
    );

    expect(query).toContain('ZOEKT_SEARCH_URL');
    expect(query).toContain('workers/slack-bot/wrangler.toml');
  });
});

function chunk(overrides: Partial<RetrievedChunk>): RetrievedChunk {
  return {
    id: 'chunk',
    repoId: 'knightmode/beacon',
    repoFullName: 'KnightMode/beacon',
    path: 'src/a.ts',
    language: 'typescript',
    chunkType: 'function',
    symbol: null,
    startLine: 1,
    endLine: 20,
    content: 'export function example() {}',
    commitSha: 'abc',
    score: 0.8,
    source: 'lexical',
    ...overrides,
  };
}

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

describe('needsStagedPrPlan', () => {
  it('detects explicitly breaking or cross-repo create-pr requests', () => {
    expect(needsStagedPrPlan('migrate all consumers for this breaking API change', '')).toBe(
      true,
    );
  });

  it('does not trigger only because retrieved context mentions dependencies', () => {
    expect(
      needsStagedPrPlan('fix the typo in the readme', '"dependencies": {"x": "1.0.0"}'),
    ).toBe(false);
  });
});

describe('buildFtsMatch', () => {
  it('drops question words from symbol extraction', () => {
    expect(parseQuery('Where are Slack request signatures verified?').symbols).toEqual([
      'Slack',
    ]);
  });

  it('quotes needles as prefix phrases joined with OR', () => {
    const match = buildFtsMatch(parseQuery('where is verifySlackSignature used'));
    expect(match).toContain('"verifySlackSignature"*');
    expect(match.split(' OR ').length).toBeGreaterThan(1);
  });

  it('adds identifier and singular variants for code search recall', () => {
    const match = buildFtsMatch(parseQuery('How does the indexer chunk markdown files?'));

    expect(match).toContain('"chunkMarkdown"*');
    expect(match).toContain('"file"*');
  });

  it('adds singular variants for plural code terms', () => {
    const match = buildFtsMatch(parseQuery('Where are Slack request signatures verified?'));

    expect(match).toContain('"signature"*');
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

describe('stripAbstentionCitations', () => {
  it('removes citation markers from clear abstentions', () => {
    expect(
      stripAbstentionCitations(
        "The provided context doesn't contain HR policy details [1][3].",
      ),
    ).toBe("The provided context doesn't contain HR policy details.");
  });

  it('keeps citation markers on grounded answers', () => {
    expect(stripAbstentionCitations('Slack signatures use HMAC [1].')).toBe(
      'Slack signatures use HMAC [1].',
    );
  });

  it('keeps citation markers when a grounded answer has a later caveat', () => {
    expect(
      stripAbstentionCitations(
        'Failures enqueue triage jobs [1]. The context does not show the Slack block formatting [2].',
      ),
    ).toBe(
      'Failures enqueue triage jobs [1]. The context does not show the Slack block formatting [2].',
    );
  });

  it('removes citations when an answer opens with a clear cannot-answer statement', () => {
    expect(
      stripAbstentionCitations(
        "I can't answer this question from the provided context [1]. The context mentions weather forecasts [2].",
      ),
    ).toBe(
      "I can't answer this question from the provided context. The context mentions weather forecasts.",
    );
  });
});

describe('parsePlannerOutput', () => {
  it('parses a done decision', () => {
    expect(parsePlannerOutput('{"done": true}')).toEqual({ done: true, tools: [] });
  });

  it('parses tool requests', () => {
    const out = parsePlannerOutput(
      '{"done": false, "tools": [{"tool":"search","query":"webhook hmac"},' +
        '{"tool":"definitions","symbol":"verifySlackSignature"}]}',
    );
    expect(out).toEqual({
      done: false,
      tools: [
        { tool: 'search', query: 'webhook hmac' },
        { tool: 'definitions', symbol: 'verifySlackSignature' },
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

describe('shouldRunPlanner', () => {
  it('keeps ordinary well-recalled questions on the fast path', () => {
    expect(
      shouldRunPlanner('how does ebpf wiremock router work?', {
        poolSize: 27,
        highConfidenceHits: 10,
        codeIntelHits: 0,
      }),
    ).toBe(false);
  });

  it('plans when first-pass evidence is weak', () => {
    expect(
      shouldRunPlanner('where is the router configured?', {
        poolSize: 3,
        highConfidenceHits: 2,
        codeIntelHits: 1,
      }),
    ).toBe(true);
  });

  it('plans when recall is broad but low quality, even without trigger words', () => {
    expect(
      shouldRunPlanner('how is a question answered end to end?', {
        poolSize: 20,
        highConfidenceHits: 2,
        codeIntelHits: 0,
      }),
    ).toBe(true);
  });

  it('plans for explicit trace and impact questions', () => {
    const strongEvidence = {
      poolSize: 27,
      highConfidenceHits: 10,
      codeIntelHits: 0,
    };
    expect(
      shouldRunPlanner('trace all callers of handleRequest across repos', strongEvidence),
    ).toBe(true);
    expect(
      shouldRunPlanner('impact analysis for this breaking change', strongEvidence),
    ).toBe(
      true,
    );
  });

  it('honors explicit modes', () => {
    const strongEvidence = {
      poolSize: 27,
      highConfidenceHits: 10,
      codeIntelHits: 0,
    };
    expect(shouldRunPlanner('anything', strongEvidence, 'always')).toBe(true);
    expect(
      shouldRunPlanner(
        'trace callers',
        { poolSize: 2, highConfidenceHits: 1, codeIntelHits: 1 },
        'off',
      ),
    ).toBe(false);
  });
});

describe('normalizeZoektResponse', () => {
  it('accepts Beacon normalized search responses', () => {
    expect(
      normalizeZoektResponse({
        matches: [
          {
            repo: 'knightmode/beacon',
            path: 'src/index.ts',
            line: 7,
            snippet: 'export default app',
            score: 0.9,
          },
        ],
      }),
    ).toEqual([
      {
        repo: 'knightmode/beacon',
        path: 'src/index.ts',
        startLine: 7,
        endLine: 7,
        snippet: 'export default app',
        score: 0.9,
      },
    ]);
  });

  it('accepts a thin zoekt-webserver proxy response shape', () => {
    expect(
      normalizeZoektResponse({
        Result: {
          Files: [
            {
              Repository: 'knightmode/beacon',
              FileName: 'workers/slack-bot/src/index.ts',
              Matches: [{ LineNum: 42, Line: 'processCreatePrJob(env, job)' }],
            },
          ],
        },
      }),
    ).toEqual([
      {
        repo: 'knightmode/beacon',
        path: 'workers/slack-bot/src/index.ts',
        startLine: 42,
        endLine: 42,
        snippet: 'processCreatePrJob(env, job)',
        score: 0.85,
      },
    ]);
  });
});
