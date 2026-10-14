/**
 * Session audit suite — `tools/session-audit.mjs`.
 *
 * The audit tool exists because a model's own account of its tools and its paths is not evidence
 * (`drafting/issues/0002`). So its own correctness matters: a leak check that misses a path, or a
 * declared-tools reading that ignores `deferLoading`, would silently certify the wrong thing. These
 * cases are built from synthetic records with the host's real field names rather than from a live log,
 * so they assert the analysis instead of today's session.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as zlib from 'node:zlib';

import {
  audit,
  classifyPaths,
  declaredTools,
  parseArgv,
  parseSession,
  pathCandidates,
  readSession,
  renderAudit,
  toolCalls,
  toolChangeBlocks,
} from '../tools/session-audit.mjs';

const ROOT = 'C:/work/project';

/** Header records carrying the two shapes that matter: a plain tool and a deferred one. */
function headerRecord(seq, tools) {
  return { type: 'request/header', seq, data: { header: { tools } } };
}

function callRecord(seq, name, args) {
  return { type: 'tool/call', seq, data: { name, arguments: JSON.stringify(args) } };
}

const RECORDS = [
  { type: 'session', seq: 1, cwd: ROOT },
  headerRecord(2, [
    { name: 'dotnet_skills_refresh', description: 'Invalidate the catalog; see dotnet_skills_status.' },
    { name: 'dotnet_skills_status', description: 'Report.', deferLoading: true },
    { name: 'read', description: 'Read a file.' },
  ]),
  callRecord(3, 'read', { file_path: 'C:\\work\\project\\src\\Program.cs' }),
  callRecord(4, 'read', { file_path: 'C:/work/project/vendor/upstream/LICENSE' }),
  callRecord(5, 'read', { file_path: 'C:/work/other-secrets/.env' }),
  callRecord(6, 'dotnet_skills_status', {}),
];

test('declaredTools reads the header and marks the deferred entries', () => {
  const { revisions, added, removed, namedBy } = declaredTools(RECORDS);
  assert.equal(revisions.length, 1);
  assert.deepEqual(
    revisions[0].tools.map((tool) => tool.name),
    ['dotnet_skills_refresh', 'dotnet_skills_status', 'read'],
  );
  assert.deepEqual(revisions[0].tools.filter((tool) => tool.deferred).map((tool) => tool.name), ['dotnet_skills_status']);
  assert.deepEqual(added, []);
  assert.deepEqual(removed, []);
  // The wire-level form of the field-test defect: the deferred tool is discoverable only because the
  // declared refresh tool's description names it.
  assert.deepEqual(revisions[0].unreachable, []);
  assert.deepEqual(namedBy.get('dotnet_skills_status'), ['dotnet_skills_refresh']);
});

test('a deferred tool nothing names is reported as unreachable', () => {
  const { revisions, namedBy } = declaredTools([
    headerRecord(1, [
      { name: 'a_refresh', description: 'Invalidate the catalog.' },
      { name: 'a_status', description: 'Report.', deferLoading: true },
    ]),
  ]);
  assert.deepEqual(namedBy.get('a_status'), []);
  assert.deepEqual(revisions[0].unreachable, ['a_status']);
  const result = audit([
    { type: 'session', seq: 0, cwd: ROOT },
    headerRecord(1, [
      { name: 'a_refresh', description: 'Invalidate the catalog.' },
      { name: 'a_status', description: 'Report.', deferLoading: true },
    ]),
  ]);
  assert.deepEqual(result.unreachableDeferred, ['a_status']);
  assert.match(renderAudit(result), /Unreachable deferred tools: a_status/);
});

test('declaredTools reports churn across revisions', () => {
  const { added, removed } = declaredTools([
    headerRecord(1, [{ name: 'a' }, { name: 'b' }]),
    headerRecord(2, [{ name: 'b' }, { name: 'c' }]),
  ]);
  assert.deepEqual(added, ['c']);
  assert.deepEqual(removed, ['a']);
});

test('toolChangeBlocks counts what the host announced', () => {
  const records = [
    {
      type: 'developer/message',
      seq: 9,
      data: { message: { content: [{ type: 'tool-addition', toolName: 'mcp_tool' }, { type: 'text', text: 'x' }] } },
    },
    { type: 'developer/message', seq: 10, data: { message: { content: [{ type: 'tool-removal', toolName: 'mcp_tool' }] } } },
    { type: 'tool/call', seq: 11, data: { name: 'read', arguments: '{}' } },
  ];
  assert.deepEqual(toolChangeBlocks(records), { additions: ['mcp_tool'], removals: ['mcp_tool'] });
});

test('pathCandidates does not mistake a URL for a POSIX path', () => {
  // A NuGet feed reported as an out-of-root read would be a false accusation, and this exact URL is
  // what the offline finding (issue 0003) produced.
  assert.deepEqual(pathCandidates('https://api.nuget.org/v3/index.json'), []);
  assert.deepEqual(pathCandidates('C:\\work\\project\\a.cs'), ['C:\\work\\project\\a.cs']);
  assert.deepEqual(pathCandidates('see /etc/hosts for the mapping'), ['/etc/hosts']);
  assert.deepEqual(pathCandidates('\\\\server\\share\\file.txt'), ['\\\\server\\share\\file.txt']);
});

test('classifyPaths separates inside, outside, relative and patterns', () => {
  const calls = toolCalls([
    callRecord(1, 'read', { file_path: 'C:/work/project/a.cs' }),
    callRecord(2, 'read', { file_path: 'other/b.cs' }),
    callRecord(3, 'read', { file_path: '../sibling/c.cs' }),
    callRecord(4, 'read', { file_path: 'C:/work/project/../secrets.txt' }),
    callRecord(5, 'glob', { pattern: 'C:/work/project/**/*.cs' }),
    callRecord(6, 'grep', { regex: 'C:/work/project/x', pattern: 'C:/work/project/y' }),
  ]);
  const result = classifyPaths(calls, ROOT);
  // The glob pattern resolves inside the root, so it is classified rather than ignored: a pattern
  // pointing outside would be a read of that directory, and skipping it would be the blind spot.
  assert.deepEqual(result.inside, ['C:/work/project/a.cs', 'C:/work/project/**/*.cs']);
  assert.equal(result.relative, 1);
  assert.equal(result.patterns, 1);
  assert.equal(result.outside.length, 2, 'the ../ path and the one that resolves outside');
  assert.deepEqual(result.outside.map((entry) => entry.tool), ['read', 'read']);
  // `grep.pattern` is a regular expression while `glob.pattern` is a path. Treating them the same
  // invents an escape out of a search term, which is how the first version produced 488 of them.
  assert.equal(
    result.outside.some((entry) => entry.path.includes('/y')),
    false,
  );
});

test('a path in a shell command is a mention, never a verdict', () => {
  // A command can name a path it never opens: a heredoc, a fixture inside a test program, a regex.
  // Reporting those as escapes is what made the first version unusable, so they are listed for a human
  // and kept out of the verdict.
  const calls = toolCalls([
    callRecord(1, 'pwsh', { command: 'node -e "readFileSync(\'C:/elsewhere/fixture.txt\')"' }),
    callRecord(2, 'edit', { file_path: 'a.cs', old_string: 'const p = "C:/elsewhere/old.cs"', new_string: '//' }),
  ]);
  const result = classifyPaths(calls, ROOT);
  assert.deepEqual(result.outside, []);
  assert.deepEqual(result.mentions, ['C:/elsewhere/fixture.txt']);
});

test('audit reports a clean session and the deferred tool it called', () => {
  const result = audit(RECORDS, { root: ROOT, allow: ['C:/work/other-secrets'] });
  assert.equal(result.root, ROOT);
  assert.deepEqual(result.deferred, ['dotnet_skills_status']);
  assert.deepEqual(result.deferredCalls, ['dotnet_skills_status']);
  assert.deepEqual(result.undeclaredCalls, []);
  assert.deepEqual(result.toolChange, { additions: [], removals: [] });
  assert.equal(result.paths.inside, 2);
  assert.equal(result.outside.length, 1);
  assert.deepEqual(result.allowed.map((entry) => entry.tool), ['read']);
  assert.deepEqual(result.violations, [], 'the only escape is covered by --allow');
  assert.match(renderAudit(result), /CLEAN/);
  assert.match(renderAudit(result), /Calls to deferred tools: dotnet_skills_status/);
  assert.match(renderAudit(result), /tool-addition: 0/);
});

test('audit fails the leak check when an escape is not allowed', () => {
  const result = audit(RECORDS, { root: ROOT });
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0].path, /other-secrets/);
  assert.match(renderAudit(result), /LEAK - 1 path/);
});

test('audit falls back to the session cwd when no root is given', () => {
  assert.equal(audit(RECORDS).root, ROOT);
  assert.equal(audit([]).root, process.cwd());
});

test('audit names calls to tools no header ever declared', () => {
  // This is the field-test failure mode in one line: the move is resolved by the registry, not by the
  // declaration set, so a call can exist for a name the model was never shown.
  const result = audit([...RECORDS, callRecord(7, 'phantom_tool', {})], { root: ROOT });
  assert.deepEqual(result.undeclaredCalls, ['phantom_tool']);
  assert.match(renderAudit(result), /no header declared: phantom_tool/);
});

test('parseSession tolerates a truncated trailing line', () => {
  const records = parseSession('{"type":"session","seq":1}\n{"type":"tool/call"\n');
  assert.equal(records.length, 1);
});

test('parseArgv requires a session and keeps repeated --allow prefixes', () => {
  assert.equal(typeof parseArgv([]), 'string');
  assert.equal(typeof parseArgv(['--session']), 'string');
  assert.equal(typeof parseArgv(['--nope']), 'string');
  const parsed = parseArgv(['--session', 'log.jsonl.zstd', '--root', 'C:/w', '--allow', 'C:/a', '--allow', 'C:/b', '--json']);
  assert.deepEqual(parsed, { session: 'log.jsonl.zstd', root: 'C:/w', allow: ['C:/a', 'C:/b'], json: true });
});

test('readSession reads a compressed log when this Node build can', () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-audit-test-'));
  try {
    const text = '{"type":"session","seq":1,"cwd":"C:/w"}\n';
    const plain = join(dir, 'session.jsonl');
    writeFileSync(plain, text, 'utf8');
    assert.equal(readSession(plain), text);

    assert.equal(typeof zlib.zstdCompressSync, 'function', 'this suite needs zstd to check the .zstd path');
    const compressed = join(dir, 'session.v4.jsonl.zstd');
    writeFileSync(compressed, zlib.zstdCompressSync(Buffer.from(text, 'utf8')));
    assert.equal(readSession(compressed), text);
    assert.equal(audit(parseSession(readSession(compressed))).root, 'C:/w');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the audit tool is not part of the shipped bundle', () => {
  // Dev tooling is deliberately absent from `package.json.files`: an installed bundle has no use for
  // a session-log reader, and shipping it would put unreviewed code on the host's resolution path.
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.files.some((entry) => entry.startsWith('tools')), false);
});
