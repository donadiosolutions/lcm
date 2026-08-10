import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { installConnector, removeConnector, listConnectors } from '../../src/connectors/installer.js';
import { LCM_MARKERS } from '../../src/connectors/constants.js';
import { AGENTS } from '../../src/connectors/registry.js';
import { mergeClaudeSettings } from '../../src/installer/settings.js';

let tmpDir: string;

const LEGACY_LCM_MARKERS = {
  START: '<!-- [LCM_CONNECTOR_START] -->',
  END: '<!-- [LCM_CONNECTOR_END] -->',
} as const;

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

type TestMarkdownEol = '\n' | '\r\n';

function generatedRulesContent(eol: TestMarkdownEol): string {
  return [
    LCM_MARKERS.START,
    '# Workflow Instruction',
    'Generated  \t',
    LCM_MARKERS.END,
  ].join(eol);
}

function legacyRulesContent(eol: TestMarkdownEol): string {
  return [
    LEGACY_LCM_MARKERS.START,
    'Legacy generated content',
    LEGACY_LCM_MARKERS.END,
  ].join(eol);
}

async function withMockedGeneratedContent<T>(
  content: string,
  callback: (install: typeof installConnector) => T | Promise<T>,
): Promise<T> {
  vi.resetModules();
  vi.doMock('../../src/connectors/template-service.js', () => ({
    generateContent: () => content,
  }));

  try {
    const { installConnector: installMockedConnector } = await import('../../src/connectors/installer.js');
    return await callback(installMockedConnector);
  } finally {
    vi.doUnmock('../../src/connectors/template-service.js');
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lcm-installer-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// Claude Code uses rules (append mode) and skill
describe('installConnector — rules (markdown append)', () => {
  it.each([
    [LEGACY_LCM_MARKERS, LCM_MARKERS],
    [LCM_MARKERS, LEGACY_LCM_MARKERS],
  ])('selects the earliest managed block across marker pairs', (first, second) => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(rulesPath, [
      first.START, '# Workflow Instruction', 'FIRST_OLD_BLOCK', first.END,
      second.START, '# Workflow Instruction', 'SECOND_OLD_BLOCK', second.END,
    ].join('\n'));
    installConnector('claude-code', 'rules', tmpDir);
    expect(readFileSync(rulesPath, 'utf-8')).not.toContain('FIRST_OLD_BLOCK');
  });
  it('writes a rules file with LCM markers', () => {
    const result = installConnector('claude-code', 'rules', tmpDir);
    expect(result.success).toBe(true);
    const content = readFileSync(result.path, 'utf-8');
    expect(content).toContain(LCM_MARKERS.START);
    expect(content).toContain(LCM_MARKERS.END);
    expect(content).toContain('lcm search');
  });

  it('appends to existing file without marker duplication', () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(rulesPath, '# My existing rules\n\nSome content here.\n');
    installConnector('claude-code', 'rules', tmpDir);
    const content = readFileSync(rulesPath, 'utf-8');
    expect(content).toContain('# My existing rules');
    expect(content).toContain(LCM_MARKERS.START);
  });

  it.each([
    [
      'uses LF when existing and generated content use LF',
      'User  \t\n',
      '\n' as TestMarkdownEol,
      `User  \t\n${generatedRulesContent('\n')}\n`,
    ],
    [
      'uses CRLF when existing content uses CRLF',
      'User  \t\r\n',
      '\n' as TestMarkdownEol,
      `User  \t\r\n${generatedRulesContent('\r\n')}\r\n`,
    ],
    [
      'uses CRLF when generated content uses CRLF',
      'User  \t\n',
      '\r\n' as TestMarkdownEol,
      `User  \t\r\n${generatedRulesContent('\r\n')}\r\n`,
    ],
  ])('%s', async (_description, existing, generatedEol, expected) => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(rulesPath, existing);

    await withMockedGeneratedContent(generatedRulesContent(generatedEol), (install) => {
      install('claude-code', 'rules', tmpDir);
    });

    expect(readFileSync(rulesPath, 'utf-8')).toBe(expected);
  });

  it.each([
    ['missing file', false],
    ['empty file', true],
  ])('handles an %s with one generated final EOL', async (_description, createFile) => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    if (createFile) writeFileSync(rulesPath, '');

    await withMockedGeneratedContent(generatedRulesContent('\r\n'), (install) => {
      install('claude-code', 'rules', tmpDir);
    });

    expect(readFileSync(rulesPath, 'utf-8')).toBe(`${generatedRulesContent('\r\n')}\r\n`);
  });

  it('reappends a CRLF managed block byte-idempotently while preserving user spaces and tabs', async () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(
      rulesPath,
      [
        'Before  \t',
        LCM_MARKERS.START,
        '# Workflow Instruction',
        'old content',
        LCM_MARKERS.END,
        '',
        'After\t',
        '',
      ].join('\r\n'),
    );
    const expected = `Before  \t\r\nAfter\t\r\n${generatedRulesContent('\r\n')}\r\n`;

    await withMockedGeneratedContent(generatedRulesContent('\n'), (install) => {
      install('claude-code', 'rules', tmpDir);
      expect(readFileSync(rulesPath, 'utf-8')).toBe(expected);
      install('claude-code', 'rules', tmpDir);
    });

    expect(readFileSync(rulesPath, 'utf-8')).toBe(expected);
  });

  it.each([
    ['current', generatedRulesContent('\r\n')],
    ['legacy', legacyRulesContent('\r\n')],
  ])('uses retained LF content instead of a stale CRLF %s block on reinstall', async (_description, staleBlock) => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(
      rulesPath,
      ['Before  \t', staleBlock, 'After\t', ''].join('\n'),
    );
    const expected = [
      'Before  \t',
      'After\t',
      generatedRulesContent('\n'),
      '',
    ].join('\n');

    await withMockedGeneratedContent(generatedRulesContent('\n'), (install) => {
      install('claude-code', 'rules', tmpDir);
    });

    expect(readFileSync(rulesPath, 'utf-8')).toBe(expected);
    expect(readFileSync(rulesPath, 'utf-8')).not.toContain('\r\n');
  });

  it.each([
    ['LF', '\n' as TestMarkdownEol],
    ['CRLF', '\r\n' as TestMarkdownEol],
  ])('keeps repeated installs fixed-point with an unmatched %s marker', async (_description, eol) => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    const existing = ['# User-authored rules', LCM_MARKERS.START].join(eol);
    writeFileSync(rulesPath, existing);
    const expected = `${existing}${eol}${generatedRulesContent(eol)}${eol}`;

    await withMockedGeneratedContent(generatedRulesContent(eol), (install) => {
      install('claude-code', 'rules', tmpDir);
      expect(readFileSync(rulesPath, 'utf-8')).toBe(expected);

      install('claude-code', 'rules', tmpDir);
    });

    const content = readFileSync(rulesPath, 'utf-8');
    expect(content).toBe(expected);
    expect(countOccurrences(content, '# Workflow Instruction')).toBe(1);
  });

  it('heals the #598 CRLF residue in one install with one generated block', async () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(
      rulesPath,
      [
        LEGACY_LCM_MARKERS.START,
        LCM_MARKERS.START,
        '# Workflow Instruction',
        '',
      ].join('\r\n'),
    );

    await withMockedGeneratedContent(generatedRulesContent('\r\n'), (install) => {
      install('claude-code', 'rules', tmpDir);
      const firstInstall = readFileSync(rulesPath, 'utf-8');
      expect(countOccurrences(firstInstall, '# Workflow Instruction')).toBe(1);

      install('claude-code', 'rules', tmpDir);
      expect(readFileSync(rulesPath, 'utf-8')).toBe(firstInstall);
    });
  });

  it('heals the #598 LF residue while preserving malformed and inline user text', async () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(
      rulesPath,
      '<!-- lcm -->\n# Workflow Instruction\n# Workflow Instruction\n<!-- [LCM_CONNECTOR_END] -->\n<!-- lcm\n<!-- lcm --> tail\n\t<!-- [LCM_CONNECTOR_START] -->\t\n',
    );

    await withMockedGeneratedContent(generatedRulesContent('\n'), (install) => {
      install('claude-code', 'rules', tmpDir);
      const firstInstall = readFileSync(rulesPath, 'utf-8');
      expect(countOccurrences(firstInstall, '# Workflow Instruction')).toBe(1);
      expect(firstInstall).toContain('<!-- lcm\n');
      expect(firstInstall).toContain('<!-- lcm --> tail');
      expect(firstInstall).toContain('\t<!-- [LCM_CONNECTOR_START] -->\t');

      install('claude-code', 'rules', tmpDir);
      expect(readFileSync(rulesPath, 'utf-8')).toBe(firstInstall);
    });
  });

  it.each([
    ['LF', '\n' as TestMarkdownEol],
    ['CRLF', '\r\n' as TestMarkdownEol],
  ])('heals duplicate same-marker blocks in one reinstall while preserving user content (%s)', async (_description, eol) => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    const firstOldBlock = generatedRulesContent(eol).replace('Generated  \t', 'FIRST_OLD_BLOCK');
    const secondOldBlock = generatedRulesContent(eol).replace('Generated  \t', 'SECOND_OLD_BLOCK');
    const existing = [
      'Before  \t',
      firstOldBlock,
      'User-authored  \t',
      secondOldBlock,
      'After\t',
      '',
    ].join(eol);
    const expected = [
      'Before  \t',
      'User-authored  \t',
      'After\t',
      generatedRulesContent(eol),
      '',
    ].join(eol);
    writeFileSync(rulesPath, existing);

    await withMockedGeneratedContent(generatedRulesContent(eol), (install) => {
      install('claude-code', 'rules', tmpDir);
      expect(readFileSync(rulesPath, 'utf-8')).toBe(expected);

      install('claude-code', 'rules', tmpDir);
    });

    expect(readFileSync(rulesPath, 'utf-8')).toBe(expected);
    expect(countOccurrences(readFileSync(rulesPath, 'utf-8'), '# Workflow Instruction')).toBe(1);
  });

  it('preserves an unmatched marker and user-authored bytes while preferring the later candidate', async () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    const retained = [
      LCM_MARKERS.START,
      '# Workflow Instruction',
      'User-authored lines  \t',
      'More user-authored bytes\t',
    ].join('\n');
    const expectedInstalled = `${retained}\n${generatedRulesContent('\n')}\n`;
    writeFileSync(rulesPath, retained);

    await withMockedGeneratedContent(generatedRulesContent('\n'), (install) => {
      install('claude-code', 'rules', tmpDir);
      const firstInstall = readFileSync(rulesPath, 'utf-8');
      expect(firstInstall).toBe(expectedInstalled);

      install('claude-code', 'rules', tmpDir);
      expect(readFileSync(rulesPath, 'utf-8')).toBe(firstInstall);
    });

    expect(removeConnector('claude-code', 'rules', tmpDir)).toBe(true);
    expect(readFileSync(rulesPath, 'utf-8')).toBe(`${retained}\n`);
  });

  it('selects a right-biased maximum set of non-overlapping adjacent candidates', async () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    const existing = [
      LCM_MARKERS.START,
      '# Workflow Instruction',
      'User-authored before the chain',
      LCM_MARKERS.START,
      '# Workflow Instruction',
      'Ambiguous user-authored middle',
      LCM_MARKERS.START,
      '# Workflow Instruction',
      'Canonical generated content',
      LCM_MARKERS.START,
    ].join('\n');
    const expected = [
      '# Workflow Instruction',
      'Ambiguous user-authored middle',
      generatedRulesContent('\n'),
      '',
    ].join('\n');
    writeFileSync(rulesPath, existing);

    await withMockedGeneratedContent(generatedRulesContent('\n'), (install) => {
      install('claude-code', 'rules', tmpDir);
      expect(readFileSync(rulesPath, 'utf-8')).toBe(expected);

      install('claude-code', 'rules', tmpDir);
    });

    expect(readFileSync(rulesPath, 'utf-8')).toBe(expected);
  });

  it.each([
    ['LF', '\n' as TestMarkdownEol],
    ['CRLF', '\r\n' as TestMarkdownEol],
  ])('preserves an EOF user heading after a valid generated block on reinstall (%s)', async (_description, eol) => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    const heading = '# Workflow Instruction';
    const existing = `${generatedRulesContent(eol)}${eol}${heading}`;
    const expected = `${heading}${eol}${generatedRulesContent(eol)}${eol}`;
    writeFileSync(rulesPath, existing);

    await withMockedGeneratedContent(generatedRulesContent(eol), (install) => {
      install('claude-code', 'rules', tmpDir);
      const firstInstall = readFileSync(rulesPath, 'utf-8');
      expect(firstInstall).toBe(expected);

      install('claude-code', 'rules', tmpDir);
      expect(readFileSync(rulesPath, 'utf-8')).toBe(firstInstall);
    });
  });

  it('does not expand a header-only marker past an unrelated preceding marker', async () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    const existing = [
      LEGACY_LCM_MARKERS.END,
      LCM_MARKERS.START,
      '# Workflow Instruction',
    ].join('\n');
    const expected = [
      LEGACY_LCM_MARKERS.END,
      generatedRulesContent('\n'),
      '',
    ].join('\n');
    writeFileSync(rulesPath, existing);

    await withMockedGeneratedContent(generatedRulesContent('\n'), (install) => {
      install('claude-code', 'rules', tmpDir);
    });

    expect(readFileSync(rulesPath, 'utf-8')).toBe(expected);
  });

  it('heals two closed blocks around a user heading gap in one reinstall', async () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    const existing = [
      LCM_MARKERS.START,
      '# Workflow Instruction',
      'FIRST_OLD_BLOCK',
      LCM_MARKERS.START,
      '# Workflow Instruction',
      'User-authored heading gap',
      LCM_MARKERS.START,
      '# Workflow Instruction',
      'SECOND_OLD_BLOCK',
      LCM_MARKERS.START,
    ].join('\n');
    const expected = [
      '# Workflow Instruction',
      'User-authored heading gap',
      generatedRulesContent('\n'),
      '',
    ].join('\n');
    writeFileSync(rulesPath, existing);

    await withMockedGeneratedContent(generatedRulesContent('\n'), (install) => {
      install('claude-code', 'rules', tmpDir);
      const firstInstall = readFileSync(rulesPath, 'utf-8');
      expect(firstInstall).toBe(expected);

      install('claude-code', 'rules', tmpDir);
      expect(readFileSync(rulesPath, 'utf-8')).toBe(firstInstall);
    });
  });

  it.each([
    ['LF', '\n' as TestMarkdownEol],
    ['CRLF', '\r\n' as TestMarkdownEol],
  ])('heals a mix of same-marker and legacy blocks in one reinstall (%s)', async (_description, eol) => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    const existing = [
      'Before',
      legacyRulesContent(eol),
      'Between',
      generatedRulesContent(eol).replace('Generated  \t', 'OLD_LCM_BLOCK'),
      'After',
      '',
    ].join(eol);
    const expected = [
      'Before',
      'Between',
      'After',
      generatedRulesContent(eol),
      '',
    ].join(eol);
    writeFileSync(rulesPath, existing);

    await withMockedGeneratedContent(generatedRulesContent(eol), (install) => {
      install('claude-code', 'rules', tmpDir);
    });

    expect(readFileSync(rulesPath, 'utf-8')).toBe(expected);
  });

  it('preserves ambiguous and user-authored marker lines while removing a later generated block', async () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    const existing = [
      'inline <!-- lcm --> text',
      `  ${LCM_MARKERS.START}`,
      'unmatched same-marker content',
      `  ${LEGACY_LCM_MARKERS.START}`,
      'unmatched legacy content',
      generatedRulesContent('\n'),
    ].join('\n');
    const expected = [
      'inline <!-- lcm --> text',
      `  ${LCM_MARKERS.START}`,
      'unmatched same-marker content',
      `  ${LEGACY_LCM_MARKERS.START}`,
      'unmatched legacy content',
      generatedRulesContent('\n'),
      '',
    ].join('\n');
    writeFileSync(rulesPath, existing);

    await withMockedGeneratedContent(generatedRulesContent('\n'), (install) => {
      install('claude-code', 'rules', tmpDir);
    });

    expect(readFileSync(rulesPath, 'utf-8')).toBe(expected);
  });

  it('pairs legacy markers across another standalone marker line', () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(
      rulesPath,
      [
        'Before',
        LEGACY_LCM_MARKERS.START,
        'Legacy managed content',
        LCM_MARKERS.START,
        'Legacy content continues',
        LEGACY_LCM_MARKERS.END,
        'After',
        '',
      ].join('\n'),
    );

    expect(removeConnector('claude-code', 'rules', tmpDir)).toBe(true);
    expect(readFileSync(rulesPath, 'utf-8')).toBe('Before\nAfter\n');
  });

  it('skips an unmatched legacy end marker before pairing a later block', () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(
      rulesPath,
      [
        LEGACY_LCM_MARKERS.END,
        LEGACY_LCM_MARKERS.START,
        'Legacy managed content',
        LEGACY_LCM_MARKERS.END,
      ].join('\n'),
    );

    expect(removeConnector('claude-code', 'rules', tmpDir)).toBe(true);
    expect(readFileSync(rulesPath, 'utf-8')).toBe(`${LEGACY_LCM_MARKERS.END}\n`);
  });

  it('advances past a nested legacy start after selecting the earliest end', () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(
      rulesPath,
      [
        'Before',
        LEGACY_LCM_MARKERS.START,
        'Outer content',
        LEGACY_LCM_MARKERS.START,
        'Nested content',
        LEGACY_LCM_MARKERS.END,
        LEGACY_LCM_MARKERS.END,
        'After',
      ].join('\n'),
    );

    expect(removeConnector('claude-code', 'rules', tmpDir)).toBe(true);
    expect(readFileSync(rulesPath, 'utf-8')).toBe(
      `Before\n${LEGACY_LCM_MARKERS.END}\nAfter\n`,
    );
  });

  it('unions a legacy wrapper and inner LCM candidate', () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(
      rulesPath,
      [
        'Before',
        LEGACY_LCM_MARKERS.START,
        'Legacy wrapper',
        LCM_MARKERS.START,
        '# Workflow Instruction',
        'Current managed content',
        LCM_MARKERS.END,
        LEGACY_LCM_MARKERS.END,
        'After',
      ].join('\n'),
    );

    expect(removeConnector('claude-code', 'rules', tmpDir)).toBe(true);
    expect(readFileSync(rulesPath, 'utf-8')).toBe('Before\nAfter\n');
  });

  it('unions crossing current and legacy blocks while preserving outside unmatched markers', () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(
      rulesPath,
      [
        LCM_MARKERS.START,
        'Unmatched current marker content',
        'Before',
        LCM_MARKERS.START,
        '# Workflow Instruction',
        LEGACY_LCM_MARKERS.START,
        'Crossing managed content',
        LCM_MARKERS.END,
        LEGACY_LCM_MARKERS.END,
        'After',
        LEGACY_LCM_MARKERS.START,
        'Unmatched legacy marker content',
      ].join('\n'),
    );

    expect(removeConnector('claude-code', 'rules', tmpDir)).toBe(true);
    expect(readFileSync(rulesPath, 'utf-8')).toBe([
      LCM_MARKERS.START,
      'Unmatched current marker content',
      'Before',
      'After',
      LEGACY_LCM_MARKERS.START,
      'Unmatched legacy marker content',
      '',
    ].join('\n'));
  });

  it('unions a current wrapper and legacy block without leaving an orphan end marker', () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(
      rulesPath,
      [
        LCM_MARKERS.START,
        '# Workflow Instruction',
        LEGACY_LCM_MARKERS.START,
        'Wrapped legacy content',
        LEGACY_LCM_MARKERS.END,
        LCM_MARKERS.END,
        'After',
        LEGACY_LCM_MARKERS.START,
        'Unmatched legacy marker content',
      ].join('\n'),
    );

    expect(removeConnector('claude-code', 'rules', tmpDir)).toBe(true);
    expect(readFileSync(rulesPath, 'utf-8')).toBe([
      'After',
      LEGACY_LCM_MARKERS.START,
      'Unmatched legacy marker content',
      '',
    ].join('\n'));
  });

  it('heals a marker-dense duplicate residue without quadratic candidate pairing', async () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    const strayMarkers = Array.from({ length: 4_000 }, () => LCM_MARKERS.START).join('\n');
    const existing = [
      strayMarkers,
      generatedRulesContent('\n').replace('Generated  \t', 'FIRST_OLD_BLOCK'),
      generatedRulesContent('\n').replace('Generated  \t', 'SECOND_OLD_BLOCK'),
      'User content',
      '',
    ].join('\n');
    writeFileSync(rulesPath, existing);

    await withMockedGeneratedContent(generatedRulesContent('\n'), (install) => {
      install('claude-code', 'rules', tmpDir);
      const firstInstall = readFileSync(rulesPath, 'utf-8');
      expect(firstInstall).toContain(strayMarkers);
      expect(countOccurrences(firstInstall, '# Workflow Instruction')).toBe(1);

      install('claude-code', 'rules', tmpDir);
      expect(readFileSync(rulesPath, 'utf-8')).toBe(firstInstall);
    });
  });

  it('is idempotent — install twice, markers appear once', () => {
    installConnector('claude-code', 'rules', tmpDir);
    installConnector('claude-code', 'rules', tmpDir);
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    const content = readFileSync(rulesPath, 'utf-8');
    expect(countOccurrences(content, LCM_MARKERS.START)).toBe(2);
  });

  it('does not replace ordinary lcm comments when appending rules', () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(
      rulesPath,
      [
        '# My existing rules',
        '',
        '<!-- lcm -->',
        'Keep this user-authored block.',
        '<!-- lcm -->',
        '',
      ].join('\n'),
    );

    installConnector('claude-code', 'rules', tmpDir);

    const content = readFileSync(rulesPath, 'utf-8');
    expect(content).toContain('Keep this user-authored block.');
    expect(countOccurrences(content, LCM_MARKERS.START)).toBe(4);
    expect(content).toContain('# Workflow Instruction');
  });

  it('returns requiresRestart: false for rules', () => {
    const result = installConnector('claude-code', 'rules', tmpDir);
    expect(result.requiresRestart).toBe(false);
  });

  it('does not treat non-missing rules read failures as an absent file', () => {
    mkdirSync(join(tmpDir, 'CLAUDE.md'));
    expect(() => installConnector('claude-code', 'rules', tmpDir)).toThrow();
  });
});

describe('installConnector — MCP JSON', () => {
  it('writes JSON with mcpServers.lcm', () => {
    const result = installConnector('claude-code', 'mcp', tmpDir);
    expect(result.success).toBe(true);
    const config = JSON.parse(readFileSync(result.path, 'utf-8'));
    expect(config.mcpServers?.lcm).toBeDefined();
    expect(config.mcpServers.lcm.command).toBe('lcm');
  });

  it('merges into existing JSON without overwriting other keys', () => {
    const mcpPath = join(tmpDir, '.mcp.json');
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: { other: { command: 'other' } } }, null, 2));
    installConnector('claude-code', 'mcp', tmpDir);
    const config = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    expect(config.mcpServers.other).toBeDefined();
    expect(config.mcpServers.lcm).toBeDefined();
  });

  it('is idempotent — install twice, lcm key appears once', () => {
    installConnector('claude-code', 'mcp', tmpDir);
    installConnector('claude-code', 'mcp', tmpDir);
    const mcpPath = join(tmpDir, '.mcp.json');
    const config = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    expect(Object.keys(config.mcpServers).filter(k => k === 'lcm').length).toBe(1);
  });

  it('returns requiresRestart: true for mcp', () => {
    const result = installConnector('claude-code', 'mcp', tmpDir);
    expect(result.requiresRestart).toBe(true);
  });

  it('recovers from malformed JSON and malformed root/server shapes', () => {
    const mcpPath = join(tmpDir, '.mcp.json');
    writeFileSync(mcpPath, 'invalid');
    installConnector('claude-code', 'mcp', tmpDir);
    expect(JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers.lcm).toBeDefined();
    writeFileSync(mcpPath, 'null');
    installConnector('claude-code', 'mcp', tmpDir);
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: [] }));
    installConnector('claude-code', 'mcp', tmpDir);
    expect(JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers.lcm).toBeDefined();
  });

  it('returns manual instructions for missing and TOML MCP configs', () => {
    expect(installConnector('cline', 'mcp', tmpDir).manual).toContain('manually');
    expect(installConnector('codex', 'mcp', tmpDir).manual).toContain('[mcp_servers.lcm]');
  });
});

describe('installConnector — skill', () => {
  it('uses an agent default type when no type is supplied', () => {
    expect(installConnector('claude-code', undefined, tmpDir).path).toContain('SKILL.md');
  });
  it('creates SKILL.md in subdirectory', () => {
    const result = installConnector('claude-code', 'skill', tmpDir);
    expect(result.success).toBe(true);
    expect(result.path).toContain('lcm-memory');
    expect(result.path).toContain('SKILL.md');
    const content = readFileSync(result.path, 'utf-8');
    expect(content).toContain('lcm search');
    expect(content).toContain('lcm store');
  });

  it('does not add markers to skill file', () => {
    const result = installConnector('claude-code', 'skill', tmpDir);
    const content = readFileSync(result.path, 'utf-8');
    expect(content).not.toContain(LCM_MARKERS.START);
  });

  it('returns requiresRestart: true for skill', () => {
    const result = installConnector('claude-code', 'skill', tmpDir);
    expect(result.requiresRestart).toBe(true);
  });
});

describe('installConnector — Codex native hooks', () => {
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
  });

  it.each([
    ['preserves trailing spaces before a terminal CRLF', 'Heading  \r\n', 'Heading  \r\n'],
    ['preserves trailing spaces without a terminal newline', 'Heading  ', 'Heading  \n'],
    ['preserves a trailing tab before a terminal CRLF', 'Heading\t\r\n', 'Heading\t\r\n'],
    ['normalizes repeated CRLF sequences to one CRLF', 'Heading\r\n\r\n\r\n', 'Heading\r\n'],
    ['normalizes mixed terminal newline sequences to one CRLF', 'Heading\r\n\n\r\n', 'Heading\r\n'],
    ['normalizes repeated LF sequences to one LF', 'Heading\n\n\n', 'Heading\n'],
    ['adds LF when content has no terminal newline', 'Heading', 'Heading\n'],
    ['normalizes empty and newline-only content', '', '\n'],
    ['normalizes LF-only content', '\n', '\n'],
    ['preserves CRLF for CRLF-only content', '\r\n', '\r\n'],
    ['normalizes CR-only content', '\r', '\n'],
  ])('%s', async (_description, input, expected) => {
    vi.resetModules();
    vi.doMock('../../src/connectors/template-service.js', () => ({
      generateContent: () => input,
    }));

    try {
      const { installConnector: installMockedConnector } = await import('../../src/connectors/installer.js');
      const result = installMockedConnector('codex', 'skill', tmpDir);
      expect(readFileSync(result.path, 'utf-8')).toBe(expected);
    } finally {
      vi.doUnmock('../../src/connectors/template-service.js');
    }
  });

  it('preserves CRLF canonical bytes across repeated Codex skill installs', async () => {
    const canonical = readFileSync(
      new URL('../../src/connectors/templates/skill/SKILL.md', import.meta.url),
      'utf-8',
    );
    const canonicalCrLf = canonical.replaceAll('\n', '\r\n');
    const skillPath = join(tmpDir, '.codex', 'skills', 'lcm-memory', 'SKILL.md');
    vi.resetModules();
    vi.doMock('../../src/connectors/template-service.js', () => ({
      generateContent: () => canonicalCrLf,
    }));

    try {
      const { installConnector: installMockedConnector } = await import('../../src/connectors/installer.js');
      installMockedConnector('codex', 'skill', tmpDir);
      const firstInstall = readFileSync(skillPath, 'utf-8');

      installMockedConnector('codex', 'skill', tmpDir);
      const secondInstall = readFileSync(skillPath, 'utf-8');

      expect(firstInstall).toBe(canonicalCrLf);
      expect(secondInstall).toBe(canonicalCrLf);
      expect(secondInstall).toBe(firstInstall);
    } finally {
      vi.doUnmock('../../src/connectors/template-service.js');
    }
  });

  it('reinstalls the Codex skill byte-identically to the canonical template', () => {
    const canonical = readFileSync(
      new URL('../../src/connectors/templates/skill/SKILL.md', import.meta.url),
      'utf-8',
    );
    const skillPath = join(tmpDir, '.codex', 'skills', 'lcm-memory', 'SKILL.md');

    installConnector('codex', 'skill', tmpDir);
    const firstInstall = readFileSync(skillPath, 'utf-8');

    installConnector('codex', 'skill', tmpDir);
    const secondInstall = readFileSync(skillPath, 'utf-8');

    expect(canonical.endsWith('\n')).toBe(true);
    expect(canonical.endsWith('\n\n')).toBe(false);
    expect(firstInstall).toBe(canonical);
    expect(secondInstall).toBe(canonical);
    expect(secondInstall).toBe(firstInstall);
  });

  it('installs hooks, skill, and global rules by default', () => {
    const result = installConnector('codex', undefined, tmpDir);

    expect(result.success).toBe(true);
    expect(result.path).toContain(join(tmpDir, '.codex', 'hooks.json'));
    expect(result.path).toContain(join(tmpDir, '.codex', 'skills', 'lcm-memory', 'SKILL.md'));
    expect(result.path).toContain(join(tmpDir, '.codex', 'AGENTS.md'));

    const hooksPath = join(tmpDir, '.codex', 'hooks.json');
    const hooks = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    expect(hooks.hooks.SessionStart[0].hooks[0].command).toBe('lcm restore --client codex');
    expect(hooks.hooks.UserPromptSubmit[0].hooks[0].command).toBe('lcm user-prompt --client codex');
    expect(hooks.hooks.PostToolUse[0].hooks[0].command).toBe('lcm post-tool --client codex');
    expect(hooks.hooks.PreCompact[0].matcher).toBe('manual|auto');
    expect(hooks.hooks.PreCompact[0].hooks[0]).toEqual({
      type: 'command',
      command: 'lcm session-snapshot --client codex',
      timeout: 30,
      statusMessage: 'Saving LCM memory before compaction',
    });
    expect(hooks.hooks.Stop[0].hooks[0].command).toBe('lcm session-snapshot --client codex');
    expect(JSON.stringify(hooks)).not.toMatch(/claude/i);

    const skill = readFileSync(join(tmpDir, '.codex', 'skills', 'lcm-memory', 'SKILL.md'), 'utf-8');
    expect(skill).toContain('lcm search');
    expect(skill).not.toMatch(/claude/i);

    const rules = readFileSync(join(tmpDir, '.codex', 'AGENTS.md'), 'utf-8');
    expect(rules).toContain(LCM_MARKERS.START);
    expect(countOccurrences(rules, LCM_MARKERS.START)).toBe(2);
    expect(rules).toContain('lcm search');
    expect(rules).toContain('lcm --help');
    expect(rules).not.toContain('@lcm');
    expect(rules).not.toContain('LCM_CONNECTOR_START');
    expect(rules).not.toMatch(/claude/i);

    const config = readFileSync(join(tmpDir, '.codex', 'config.toml'), 'utf-8');
    expect(config).toContain('[features]');
    expect(config).toContain('hooks = true');
    expect(config).not.toContain('codex_hooks');
    expect(config).not.toMatch(/claude/i);
  });

  it('idempotently ensures Codex rules in ~/.codex/AGENTS.md', () => {
    installConnector('codex', 'rules', tmpDir);
    installConnector('codex', 'rules', tmpDir);

    const rulesPath = join(tmpDir, '.codex', 'AGENTS.md');
    const content = readFileSync(rulesPath, 'utf-8');
    expect(countOccurrences(content, LCM_MARKERS.START)).toBe(2);
    expect(content).toContain('lcm search');
  });

  it('preserves existing user content when installing Codex rules', () => {
    const rulesPath = join(tmpDir, '.codex', 'AGENTS.md');
    mkdirSync(join(tmpDir, '.codex'), { recursive: true });
    writeFileSync(rulesPath, '# Personal Codex rules\n\nNever overwrite this.\n');

    installConnector('codex', 'rules', tmpDir);

    const content = readFileSync(rulesPath, 'utf-8');
    expect(content).toContain('# Personal Codex rules');
    expect(content).toContain('Never overwrite this.');
    expect(content).toContain(LCM_MARKERS.START);
    expect(content).toContain(LCM_MARKERS.END);
    expect(countOccurrences(content, LCM_MARKERS.START)).toBe(2);
    expect(content).toContain('lcm search');
  });

  it('updates only the marked Codex rules block on reinstall', () => {
    const rulesPath = join(tmpDir, '.codex', 'AGENTS.md');
    mkdirSync(join(tmpDir, '.codex'), { recursive: true });
    writeFileSync(
      rulesPath,
      [
        '# Personal Codex rules',
        '',
        'Keep this before.',
        LCM_MARKERS.START,
        '# Workflow Instruction',
        '',
        'old managed content',
        LCM_MARKERS.END,
        'Keep this after.',
        '',
      ].join('\n'),
    );

    installConnector('codex', 'rules', tmpDir);

    const content = readFileSync(rulesPath, 'utf-8');
    expect(countOccurrences(content, LCM_MARKERS.START)).toBe(2);
    expect(content).toContain('# Personal Codex rules');
    expect(content).toContain('Keep this before.');
    expect(content).toContain('Keep this after.');
    expect(content).toContain('Keep this before.\nKeep this after.');
    expect(content).not.toContain('old managed content');
    expect(content).toContain('lcm search');
  });

  it('migrates legacy bracketed Codex rules markers on reinstall', () => {
    const rulesPath = join(tmpDir, '.codex', 'AGENTS.md');
    mkdirSync(join(tmpDir, '.codex'), { recursive: true });
    writeFileSync(
      rulesPath,
      [
        '# Personal Codex rules',
        '',
        'Keep this before.',
        LEGACY_LCM_MARKERS.START,
        'old managed content',
        '---',
        '@lcm Codex',
        LEGACY_LCM_MARKERS.END,
        'Keep this after.',
        '',
      ].join('\n'),
    );

    installConnector('codex', 'rules', tmpDir);

    const content = readFileSync(rulesPath, 'utf-8');
    expect(countOccurrences(content, LCM_MARKERS.START)).toBe(2);
    expect(content).toContain('# Personal Codex rules');
    expect(content).toContain('Keep this before.');
    expect(content).toContain('Keep this after.');
    expect(content).toContain('Keep this before.\nKeep this after.');
    expect(content).not.toContain(LEGACY_LCM_MARKERS.START);
    expect(content).not.toContain(LEGACY_LCM_MARKERS.END);
    expect(content).not.toContain('old managed content');
    expect(content).not.toContain('@lcm Codex');
    expect(content).toContain('lcm --help');
  });

  it('migrates the deprecated codex_hooks feature flag when installing hooks', () => {
    const configPath = join(tmpDir, '.codex', 'config.toml');
    mkdirSync(join(tmpDir, '.codex'), { recursive: true });
    writeFileSync(configPath, '[features]\ncodex_hooks = true\n');

    installConnector('codex', 'hook', tmpDir);

    const config = readFileSync(configPath, 'utf-8');
    expect(config).toBe('[features]\nhooks = true\n');
  });

  it('is idempotent and preserves existing Codex hooks', () => {
    const hooksPath = join(tmpDir, '.codex', 'hooks.json');
    mkdirSync(join(tmpDir, '.codex'), { recursive: true });
    writeFileSync(hooksPath, JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [{ type: 'command', command: 'echo existing' }],
          },
        ],
        PreCompact: [
          {
            matcher: 'manual|auto',
            hooks: [{ type: 'command', command: 'node "/tmp/honcho.mjs" writeback' }],
          },
        ],
      },
    }, null, 2));

    installConnector('codex', 'hook', tmpDir);
    installConnector('codex', 'hook', tmpDir);

    const hooks = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    const commands = hooks.hooks.SessionStart.flatMap((group: any) => group.hooks.map((hook: any) => hook.command));
    expect(commands).toContain('echo existing');
    expect(commands.filter((command: string) => command === 'lcm restore --client codex')).toHaveLength(1);

    const preCompactCommands = hooks.hooks.PreCompact.flatMap((group: any) => group.hooks.map((hook: any) => hook.command));
    expect(preCompactCommands).toContain('node "/tmp/honcho.mjs" writeback');
    expect(preCompactCommands.filter((command: string) => command === 'lcm session-snapshot --client codex')).toHaveLength(1);
    const lcmPreCompactGroup = hooks.hooks.PreCompact.find((group: any) =>
      group.hooks.some((hook: any) => hook.command === 'lcm session-snapshot --client codex'),
    );
    expect(lcmPreCompactGroup).toBeDefined();
    expect(lcmPreCompactGroup?.matcher).toBe('manual|auto');
  });

  it('lists and removes Codex hooks', () => {
    const result = installConnector('codex', 'hook', tmpDir);
    const installed = listConnectors(tmpDir);
    expect(installed.some(c => c.agentId === 'codex' && c.type === 'hook')).toBe(true);

    expect(removeConnector('codex', 'hook', tmpDir)).toBe(true);
    expect(listConnectors(tmpDir).some(c => c.agentId === 'codex' && c.type === 'hook')).toBe(false);
    expect(existsSync(result.path)).toBe(false);
  });

  it('removes old LCM hooks from legacy cwd hooks.json when installing the user hook file', () => {
    const projectDir = join(tmpDir, 'project');
    const cwdHooksPath = join(projectDir, '.codex', 'hooks.json');
    mkdirSync(join(projectDir, '.codex'), { recursive: true });
    mkdirSync(join(tmpDir, '.codex'), { recursive: true });
    writeFileSync(cwdHooksPath, JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'echo keep' }] },
          { hooks: [{ type: 'command', command: 'lcm restore --client codex' }] },
        ],
      },
    }, null, 2));

    installConnector('codex', 'hook', projectDir);

    expect(existsSync(join(tmpDir, '.codex', 'hooks.json'))).toBe(true);
    const legacy = JSON.parse(readFileSync(cwdHooksPath, 'utf-8'));
    const commands = legacy.hooks.SessionStart.flatMap((group: any) => group.hooks.map((hook: any) => hook.command));
    expect(commands).toEqual(['echo keep']);
  });
});

describe('removeConnector — rules', () => {
  it('removes markers from existing rules file', () => {
    installConnector('claude-code', 'rules', tmpDir);
    const removed = removeConnector('claude-code', 'rules', tmpDir);
    expect(removed).toBe(true);
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    // File deleted when empty, or content has no markers
    try {
      const content = readFileSync(rulesPath, 'utf-8');
      expect(content).not.toContain(LCM_MARKERS.START);
      expect(content).not.toContain(LEGACY_LCM_MARKERS.START);
    } catch {
      // File was deleted — also acceptable
    }
  });

  it('preserves non-lcm content when removing markers', () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(rulesPath, '# My Rules\n\nKeep this.\n');
    installConnector('claude-code', 'rules', tmpDir);
    removeConnector('claude-code', 'rules', tmpDir);
    const content = readFileSync(rulesPath, 'utf-8');
    expect(content).toContain('Keep this');
    expect(content).not.toContain(LCM_MARKERS.START);
    expect(content).not.toContain(LEGACY_LCM_MARKERS.START);
  });

  it('removes legacy bracketed marker blocks', () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(
      rulesPath,
      [
        '# My Rules',
        '',
        'Keep this before.',
        LEGACY_LCM_MARKERS.START,
        'old managed content',
        LEGACY_LCM_MARKERS.END,
        'Keep this after.',
        '',
      ].join('\n'),
    );

    expect(removeConnector('claude-code', 'rules', tmpDir)).toBe(true);

    const content = readFileSync(rulesPath, 'utf-8');
    expect(content).toContain('Keep this before.');
    expect(content).toContain('Keep this after.');
    expect(content).toContain('Keep this before.\nKeep this after.');
    expect(content).not.toContain(LEGACY_LCM_MARKERS.START);
    expect(content).not.toContain('old managed content');
  });

  it('preserves CRLF and Markdown spaces when removing a managed block', () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(
      rulesPath,
      [
        'Before  \t',
        LCM_MARKERS.START,
        '# Workflow Instruction',
        'managed content',
        LCM_MARKERS.END,
        'After\t',
        '',
      ].join('\r\n'),
    );

    expect(removeConnector('claude-code', 'rules', tmpDir)).toBe(true);
    expect(readFileSync(rulesPath, 'utf-8')).toBe('Before  \t\r\nAfter\t\r\n');
  });

  it.each([
    ['current', generatedRulesContent('\r\n')],
    ['legacy', legacyRulesContent('\r\n')],
  ])('uses retained LF content instead of a stale CRLF %s block on removal', (_description, staleBlock) => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(
      rulesPath,
      ['Before  \t', staleBlock, 'After\t', ''].join('\n'),
    );

    expect(removeConnector('claude-code', 'rules', tmpDir)).toBe(true);
    expect(readFileSync(rulesPath, 'utf-8')).toBe('Before  \t\nAfter\t\n');
    expect(readFileSync(rulesPath, 'utf-8')).not.toContain('\r\n');
  });

  it('recognizes adjacent standalone same-marker lines when removing a managed block', () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(
      rulesPath,
      [
        LCM_MARKERS.START,
        LCM_MARKERS.START,
        '# Workflow Instruction',
        'managed content',
        LCM_MARKERS.END,
      ].join('\n'),
    );

    expect(removeConnector('claude-code', 'rules', tmpDir)).toBe(true);
    expect(readFileSync(rulesPath, 'utf-8')).toBe(`${LCM_MARKERS.START}\n`);
  });

  it.each([
    ['LF', '\n' as TestMarkdownEol],
    ['CRLF', '\r\n' as TestMarkdownEol],
  ])('removes every recognized block at file boundaries while preserving the user section (%s)', (_description, eol) => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(
      rulesPath,
      [
        generatedRulesContent(eol),
        '',
        'Keep  \t',
        '',
        legacyRulesContent(eol),
      ].join(eol),
    );

    expect(removeConnector('claude-code', 'rules', tmpDir)).toBe(true);
    expect(readFileSync(rulesPath, 'utf-8')).toBe(`Keep  \t${eol}`);
  });

  it('removes a valid generated block without deleting an exact EOF user heading', async () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    const heading = '# Workflow Instruction';
    writeFileSync(rulesPath, `${generatedRulesContent('\n')}\n${heading}`);

    expect(removeConnector('claude-code', 'rules', tmpDir)).toBe(true);
    expect(readFileSync(rulesPath, 'utf-8')).toBe(`${heading}\n`);
  });

  it('deletes the file when all duplicate recognized blocks are removed', () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(
      rulesPath,
      [generatedRulesContent('\n'), generatedRulesContent('\n'), ''].join('\n'),
    );

    expect(removeConnector('claude-code', 'rules', tmpDir)).toBe(true);
    expect(existsSync(rulesPath)).toBe(false);
  });

  it.each([
    ['LF', '\n' as TestMarkdownEol],
    ['CRLF', '\r\n' as TestMarkdownEol],
  ])('preserves whitespace-only user Markdown outside a managed block (%s)', (_description, eol) => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    const whitespace = '  \t\f';
    writeFileSync(rulesPath, [whitespace, generatedRulesContent(eol), ''].join(eol));

    expect(removeConnector('claude-code', 'rules', tmpDir)).toBe(true);
    expect(existsSync(rulesPath)).toBe(true);
    expect(readFileSync(rulesPath, 'utf-8')).toBe(`${whitespace}${eol}`);
  });

  it.each([
    ['LF', '\n' as TestMarkdownEol],
    ['CRLF', '\r\n' as TestMarkdownEol],
  ])('deletes rules with only blank lines outside a managed block (%s)', (_description, eol) => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(rulesPath, ['', generatedRulesContent(eol), ''].join(eol));

    expect(removeConnector('claude-code', 'rules', tmpDir)).toBe(true);
    expect(existsSync(rulesPath)).toBe(false);
  });

  it('removes a generated same-marker block at the file boundaries', () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(
      rulesPath,
      [LCM_MARKERS.START, '# Workflow Instruction', LCM_MARKERS.END].join('\n'),
    );

    expect(removeConnector('claude-code', 'rules', tmpDir)).toBe(true);
    expect(existsSync(rulesPath)).toBe(false);
  });

  it('recognizes whitespace-indented standalone marker lines', () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(
      rulesPath,
      [
        'Before',
        ` \t${LCM_MARKERS.START}`,
        '# Workflow Instruction',
        `\t${LCM_MARKERS.END}`,
        'After',
      ].join('\n'),
    );

    expect(removeConnector('claude-code', 'rules', tmpDir)).toBe(true);
    expect(readFileSync(rulesPath, 'utf-8')).toBe('Before\nAfter\n');
  });

  it('returns false when file does not exist', () => {
    const removed = removeConnector('claude-code', 'rules', tmpDir);
    expect(removed).toBe(false);
  });

  it('returns false when markers not present', () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(rulesPath, '# No markers here\n');
    const removed = removeConnector('claude-code', 'rules', tmpDir);
    expect(removed).toBe(false);
  });

  it('returns false for ordinary lcm comments and preserves user content', () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    const original = [
      '# My Rules',
      '',
      '<!-- lcm -->',
      'Keep this user-authored block.',
      '<!-- lcm -->',
      '',
    ].join('\n');
    writeFileSync(rulesPath, original);

    expect(removeConnector('claude-code', 'rules', tmpDir)).toBe(false);
    expect(readFileSync(rulesPath, 'utf-8')).toBe(original);
  });

  it('preserves inline and unmatched legacy markers as user content', () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    const original = [
      'inline <!-- lcm --> text',
      `  ${LEGACY_LCM_MARKERS.START}`,
      'unmatched legacy marker content',
    ].join('\n');
    writeFileSync(rulesPath, original);

    expect(removeConnector('claude-code', 'rules', tmpDir)).toBe(false);
    expect(readFileSync(rulesPath, 'utf-8')).toBe(original);
  });
});

describe('removeConnector — MCP JSON', () => {
  it('removes mcpServers.lcm from JSON', () => {
    installConnector('claude-code', 'mcp', tmpDir);
    const removed = removeConnector('claude-code', 'mcp', tmpDir);
    expect(removed).toBe(true);
    const mcpPath = join(tmpDir, '.mcp.json');
    const config = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    expect(config.mcpServers?.lcm).toBeUndefined();
  });

  it('returns false when file does not exist', () => {
    expect(removeConnector('claude-code', 'mcp', tmpDir)).toBe(false);
  });

  it('returns false when lcm key not present', () => {
    const mcpPath = join(tmpDir, '.mcp.json');
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }, null, 2));
    expect(removeConnector('claude-code', 'mcp', tmpDir)).toBe(false);
  });

  it('returns false for malformed JSON and TOML configs', () => {
    const mcpPath = join(tmpDir, '.mcp.json');
    writeFileSync(mcpPath, 'invalid');
    expect(removeConnector('claude-code', 'mcp', tmpDir)).toBe(false);
    expect(removeConnector('codex', 'mcp', tmpDir)).toBe(false);
  });
});

describe('removeConnector — skill', () => {
  it('removes SKILL.md', () => {
    const result = installConnector('claude-code', 'skill', tmpDir);
    const removed = removeConnector('claude-code', 'skill', tmpDir);
    expect(removed).toBe(true);
    expect(() => readFileSync(result.path, 'utf-8')).toThrow();
  });

  it('returns false when skill not installed', () => {
    expect(removeConnector('claude-code', 'skill', tmpDir)).toBe(false);
  });
});

describe('listConnectors', () => {
  it('finds installed rules connector', () => {
    installConnector('claude-code', 'rules', tmpDir);
    const list = listConnectors(tmpDir);
    const found = list.find(c => c.agentId === 'claude-code' && c.type === 'rules');
    expect(found).toBeDefined();
  });

  it('finds legacy bracketed rules connector', () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(
      rulesPath,
      [
        LEGACY_LCM_MARKERS.START,
        'old managed content',
        LEGACY_LCM_MARKERS.END,
        '',
      ].join('\n'),
    );

    const list = listConnectors(tmpDir);
    const found = list.find(c => c.agentId === 'claude-code' && c.type === 'rules');
    expect(found).toBeDefined();
  });

  it('does not list ordinary lcm comments as a rules connector', () => {
    const rulesPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(
      rulesPath,
      [
        '<!-- lcm -->',
        'Keep this user-authored block.',
        '<!-- lcm -->',
        '',
      ].join('\n'),
    );

    const list = listConnectors(tmpDir);
    const found = list.find(c => c.agentId === 'claude-code' && c.type === 'rules');
    expect(found).toBeUndefined();
  });

  it('finds installed MCP connector', () => {
    installConnector('claude-code', 'mcp', tmpDir);
    const list = listConnectors(tmpDir);
    const found = list.find(c => c.agentId === 'claude-code' && c.type === 'mcp');
    expect(found).toBeDefined();
  });

  it('finds installed skill connector', () => {
    installConnector('claude-code', 'skill', tmpDir);
    const list = listConnectors(tmpDir);
    const found = list.find(c => c.agentId === 'claude-code' && c.type === 'skill');
    expect(found).toBeDefined();
  });

  it('returns empty when nothing installed', () => {
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const list = listConnectors(tmpDir);
      expect(list).toHaveLength(0);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it('ignores malformed and unconfigured MCP files', () => {
    writeFileSync(join(tmpDir, '.mcp.json'), 'invalid');
    mkdirSync(join(tmpDir, '.qwen'), { recursive: true });
    writeFileSync(join(tmpDir, '.qwen', 'mcp.json'), JSON.stringify({ mcpServers: {} }), { flag: 'w' });
    expect(listConnectors(tmpDir).some(c => c.type === 'mcp')).toBe(false);
  });

  it('does not list removed connectors', () => {
    installConnector('claude-code', 'rules', tmpDir);
    removeConnector('claude-code', 'rules', tmpDir);
    const list = listConnectors(tmpDir);
    const found = list.find(c => c.agentId === 'claude-code' && c.type === 'rules');
    expect(found).toBeUndefined();
  });
});

describe('error handling', () => {
  it('throws when removing an unknown agent', () => {
    expect(() => removeConnector('unknown-agent-xyz', 'rules', tmpDir)).toThrow('Unknown agent');
  });
  it('throws for unknown agent', () => {
    expect(() => installConnector('unknown-agent-xyz', 'rules', tmpDir)).toThrow('Unknown agent');
  });

  it('throws for unsupported connector type', () => {
    // Zed only supports rules and mcp, not skill
    expect(() => installConnector('zed', 'skill', tmpDir)).toThrow('does not support connector type');
  });

  it('routes Claude hook installation through the guarded npm installer', () => {
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const settingsPath = join(tmpDir, '.claude', 'settings.json');
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ theme: 'dark' }));
      const result = installConnector('claude-code', 'hook', tmpDir);
      expect(result.path).toBe('');
      expect(result.requiresRestart).toBe(false);
      expect(result.manual).toContain('lcm install');
      expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ theme: 'dark' });
      writeFileSync(
        settingsPath,
        JSON.stringify(mergeClaudeSettings({ theme: 'dark' }, join(process.cwd(), 'dist', 'lcm.mjs'))),
      );
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      settings.mcpServers = {
        lcm: { command: '/opt/npm/bin/lcm', args: ['mcp'] },
        unrelated: { command: 'other' },
      };
      settings.hooks.SessionStart.unshift({
        matcher: 'unrelated',
        hooks: [{ type: 'command', command: '/usr/local/bin/other restore' }],
      });
      settings.hooks.PreCompact.reverse();
      writeFileSync(settingsPath, JSON.stringify(settings));
      expect(listConnectors(tmpDir)).toEqual(expect.arrayContaining([
        expect.objectContaining({ agentId: 'claude-code', type: 'hook', path: settingsPath }),
      ]));
      settings.hooks.Stop = settings.hooks.Stop.filter((entry: any) =>
        !entry.hooks?.some((hook: any) => hook.command?.includes('session-snapshot'))
      );
      writeFileSync(settingsPath, JSON.stringify(settings));
      expect(listConnectors(tmpDir).some((entry) =>
        entry.agentId === 'claude-code' && entry.type === 'hook'
      )).toBe(false);
      writeFileSync(
        settingsPath,
        JSON.stringify(mergeClaudeSettings(settings, join(process.cwd(), 'dist', 'lcm.mjs'))),
      );
      expect(removeConnector('claude-code', 'hook', tmpDir)).toBe(true);
      expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
        theme: 'dark',
        hooks: {
          SessionStart: [{
            matcher: 'unrelated',
            hooks: [{ type: 'command', command: '/usr/local/bin/other restore' }],
          }],
        },
        mcpServers: {
          lcm: { command: '/opt/npm/bin/lcm', args: ['mcp'] },
          unrelated: { command: 'other' },
        },
      });
      expect(removeConnector('claude-code', 'hook', tmpDir)).toBe(false);
      rmSync(settingsPath);
      expect(removeConnector('claude-code', 'hook', tmpDir)).toBe(false);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it('fails closed for malformed Claude settings and unsupported native hook agents', () => {
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const settingsPath = join(tmpDir, '.claude', 'settings.json');
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, 'null');
      expect(installConnector('claude-code', 'hook', tmpDir).manual).toContain('lcm install');
      expect(listConnectors(tmpDir).some((entry) => entry.agentId === 'claude-code' && entry.type === 'hook')).toBe(false);
      expect(() => removeConnector('claude-code', 'hook', tmpDir)).toThrow('must contain a JSON object');

      const codex = AGENTS.find((candidate) => candidate.id === 'codex')!;
      const originalId = codex.id;
      codex.id = 'codex-other';
      try {
        expect(() => installConnector('Codex', 'hook', tmpDir)).toThrow('Native hook installation is not implemented');
      } finally {
        codex.id = originalId;
      }
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it('detects canonical Claude hooks through malformed and unrelated surrounding entries', () => {
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const settingsPath = join(tmpDir, '.claude', 'settings.json');
      mkdirSync(dirname(settingsPath), { recursive: true });
      const runtimePath = join(process.cwd(), 'dist', 'lcm.mjs');
      const canonical = mergeClaudeSettings({}, runtimePath);
      const isListed = () => listConnectors(tmpDir).some((entry) =>
        entry.agentId === 'claude-code' && entry.type === 'hook'
      );

      for (const hooks of [undefined, null, 'invalid', []]) {
        writeFileSync(settingsPath, JSON.stringify(hooks === undefined ? {} : { hooks }));
        expect(isListed()).toBe(false);
      }

      writeFileSync(settingsPath, JSON.stringify({ hooks: { ...canonical.hooks, PostToolUse: 'invalid' } }));
      expect(isListed()).toBe(false);

      canonical.hooks.PostToolUse = [
        null,
        'unrelated',
        [],
        {},
        { hooks: 'invalid' },
        {
          hooks: [
            null,
            'unrelated',
            [],
            {},
            { command: 'wrong' },
            {
              type: 'prompt',
              command: canonical.hooks.PostToolUse[0].hooks[0].command,
            },
            canonical.hooks.PostToolUse[0].hooks[0],
          ],
        },
      ];
      writeFileSync(settingsPath, JSON.stringify(canonical));
      expect(isListed()).toBe(true);

      canonical.hooks.PostToolUse[5].hooks.pop();
      writeFileSync(settingsPath, JSON.stringify(canonical));
      expect(isListed()).toBe(false);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it('still routes Claude hook installation when its legacy configured path is absent', () => {
    const agent = AGENTS.find((candidate) => candidate.id === 'claude-code')!;
    const original = agent.configPaths.hook;
    delete agent.configPaths.hook;
    try {
      expect(installConnector('claude-code', 'hook', tmpDir).manual).toContain('lcm install');
    } finally {
      agent.configPaths.hook = original;
    }
  });

  it('uses overwrite rules mode when an agent writeMode is nullish', () => {
    const agent = AGENTS.find((candidate) => candidate.id === 'gemini-cli')!;
    const original = agent.writeMode;
    agent.writeMode = null as never;
    try {
      expect(installConnector('gemini-cli', 'rules', tmpDir).success).toBe(true);
    } finally {
      agent.writeMode = original;
    }
  });

  it('throws when a supported connector has no configured non-MCP path', () => {
    const agent = AGENTS.find((candidate) => candidate.id === 'zed')!;
    const original = agent.configPaths.rules;
    delete agent.configPaths.rules;
    try {
      expect(() => installConnector('zed', 'rules', tmpDir)).toThrow('No config path defined');
      expect(removeConnector('zed', 'rules', tmpDir)).toBe(false);
    } finally {
      agent.configPaths.rules = original;
    }
  });

  it('throws the config-path contract error when Codex has no hook path', () => {
    const agent = AGENTS.find((candidate) => candidate.id === 'codex')!;
    const original = agent.configPaths.hook;
    delete agent.configPaths.hook;
    try {
      expect(() => installConnector('codex', 'hook', tmpDir))
        .toThrow('No config path defined for Codex with type hook');
    } finally {
      agent.configPaths.hook = original;
    }
  });

  it('removes all default Codex connector types', () => {
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      installConnector('codex', undefined, tmpDir);
      expect(removeConnector('codex', undefined, tmpDir)).toBe(true);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it('handles absent default connector installs and a default single type removal', () => {
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      expect(removeConnector('codex', undefined, tmpDir)).toBe(false);
      installConnector('claude-code', undefined, tmpDir);
      expect(removeConnector('claude-code', undefined, tmpDir)).toBe(true);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });
});
