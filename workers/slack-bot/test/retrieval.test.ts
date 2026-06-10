import { describe, it, expect } from 'vitest';
import { buildFtsMatch } from '../src/retrieval/lexical.js';
import { parseQuery } from '../src/retrieval/queryUnderstanding.js';
import { parsePlannerOutput } from '../src/retrieval/agent.js';

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
