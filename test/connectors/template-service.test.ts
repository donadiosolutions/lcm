import { describe, it, expect } from 'vitest';
import { generateRulesContent, generateMcpContent, generateSkillContent, generateContent } from '../../src/connectors/template-service.js';
import { LCM_MARKERS } from '../../src/connectors/constants.js';
import type { Agent } from '../../src/connectors/types.js';

const mockAgent: Agent = {
  id: 'test-agent',
  name: 'Test Agent',
  category: 'cli',
  defaultType: 'rules',
  supportedTypes: ['rules', 'mcp', 'skill'],
  configPaths: {
    rules: 'TEST.md',
    mcp: '.test/mcp.json',
    skill: '.test/skills/',
  },
};

const mockAgentWithHeader: Agent = {
  ...mockAgent,
  header: '---\ntrigger: always_on\n---',
};

const codexAgent: Agent = {
  ...mockAgent,
  id: 'codex',
  name: 'Codex',
  configPaths: {
    rules: '~/.codex/AGENTS.md',
    hook: '~/.codex/hooks.json',
    mcp: '.codex/config.toml',
    skill: '.codex/skills/',
  },
};

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

describe('generateRulesContent', () => {
  it('contains lcm search command', () => {
    const content = generateRulesContent(mockAgent);
    expect(content).toContain('lcm search');
  });

  it('contains LCM_MARKERS.START', () => {
    const content = generateRulesContent(mockAgent);
    expect(content).toContain(LCM_MARKERS.START);
  });

  it('contains LCM_MARKERS.END', () => {
    const content = generateRulesContent(mockAgent);
    expect(content).toContain(LCM_MARKERS.END);
  });

  it('contains exactly one managed lcm block', () => {
    const content = generateRulesContent(mockAgent);
    expect(countOccurrences(content, LCM_MARKERS.START)).toBe(2);
  });

  it('substitutes all template variables (no {{}} placeholders remain)', () => {
    const content = generateRulesContent(mockAgent);
    expect(content).not.toMatch(/\{\{[^}]+\}\}/);
  });

  it('includes header when agent has one', () => {
    const content = generateRulesContent(mockAgentWithHeader);
    expect(content).toContain('trigger: always_on');
  });

  it('does not include header when agent has none', () => {
    const content = generateRulesContent(mockAgent);
    expect(content).not.toContain('trigger:');
  });

  it('contains available commands without the removed directives', () => {
    const content = generateRulesContent(mockAgent);
    expect(content).toContain('## Available Commands');
    expect(content).toContain('lcm search "query"');
    expect(content).toContain('lcm grep "pattern" --mode regex');
    expect(content).toContain('lcm describe <nodeId>');
    expect(content).toContain('lcm expand <nodeId> --depth N');
    expect(content).toContain('lcm store');
    expect(content).toContain('lcm doctor');
    expect(content).toContain('lcm diagnose');
    expect(content).toContain('`lcm import`');
    expect(content).toContain('lcm import --all');
    expect(content).toContain('Run `lcm --help` for all options.');
    expect(content).not.toContain('lcm stats');
    expect(content).not.toContain('lcm import --codex');
    expect(content).not.toContain('lcm import --provider all');
    expect(content).not.toContain('lcm compact --all');
  });

  it('omits legacy markers, footer tag, and extra separator', () => {
    const content = generateRulesContent(mockAgent);
    expect(content).not.toContain('LCM_CONNECTOR_START');
    expect(content).not.toContain('LCM_CONNECTOR_END');
    expect(content).not.toContain('@lcm');
    expect(content).not.toContain('Test Agent');
    expect(content).not.toContain('\n---\n');
    expect(content).not.toContain('You are a coding agent.');
  });

  it('keeps Codex generated rules free of Claude-specific text', () => {
    const content = generateRulesContent(codexAgent);
    expect(content).not.toMatch(/claude/i);
  });
});

describe('generateMcpContent', () => {
  it('contains lcm_search MCP tool', () => {
    const content = generateMcpContent(mockAgent);
    expect(content).toContain('lcm_search');
  });

  it('contains LCM_MARKERS.START', () => {
    const content = generateMcpContent(mockAgent);
    expect(content).toContain(LCM_MARKERS.START);
  });

  it('contains LCM_MARKERS.END', () => {
    const content = generateMcpContent(mockAgent);
    expect(content).toContain(LCM_MARKERS.END);
  });

  it('contains exactly one managed lcm block', () => {
    const content = generateMcpContent(mockAgent);
    expect(countOccurrences(content, LCM_MARKERS.START)).toBe(2);
  });

  it('substitutes all template variables', () => {
    const content = generateMcpContent(mockAgent);
    expect(content).not.toMatch(/\{\{[^}]+\}\}/);
  });

  it('contains lcm_store tool', () => {
    const content = generateMcpContent(mockAgent);
    expect(content).toContain('lcm_store');
  });

  it('omits footer tag and extra separator', () => {
    const content = generateMcpContent(mockAgent);
    expect(content).not.toContain('@lcm');
    expect(content).not.toContain('Test Agent');
    expect(content).not.toContain('\n---\n');
  });

  it('keeps Codex generated MCP guidance free of Claude-specific text', () => {
    const content = generateMcpContent(codexAgent);
    expect(content).not.toMatch(/claude/i);
  });
});

describe('generateSkillContent', () => {
  it('contains lcm search command', () => {
    const content = generateSkillContent(mockAgent);
    expect(content).toContain('lcm search');
  });

  it('contains lcm store command', () => {
    const content = generateSkillContent(mockAgent);
    expect(content).toContain('lcm store');
  });

  it('contains a describe example with a node id', () => {
    const content = generateSkillContent(mockAgent);
    expect(content).toContain('lcm describe sum_abc123def456');
  });

  it('contains an expand example with explicit depth', () => {
    const content = generateSkillContent(mockAgent);
    expect(content).toContain('lcm expand sum_abc123def456 --depth 2');
  });

  it('does not contain LCM start marker (standalone file)', () => {
    const content = generateSkillContent(mockAgent);
    expect(content).not.toContain(LCM_MARKERS.START);
  });

  it('does not contain LCM end marker (standalone file)', () => {
    const content = generateSkillContent(mockAgent);
    expect(content).not.toContain(LCM_MARKERS.END);
  });

  it('contains YAML frontmatter', () => {
    const content = generateSkillContent(mockAgent);
    expect(content).toContain('name: lcm-memory');
  });

  it('keeps generated Codex skill content free of Claude-specific text', () => {
    const content = generateSkillContent(codexAgent);
    expect(content).not.toMatch(/claude/i);
  });
});

describe('generateContent dispatch', () => {
  it('delegates rules to generateRulesContent', () => {
    const content = generateContent(mockAgent, 'rules');
    expect(content).toContain(LCM_MARKERS.START);
    expect(content).toContain('lcm search');
    expect(content).toContain('lcm --help');
  });

  it('delegates mcp to generateMcpContent', () => {
    const content = generateContent(mockAgent, 'mcp');
    expect(content).toContain('lcm_search');
  });

  it('delegates skill to generateSkillContent', () => {
    const content = generateContent(mockAgent, 'skill');
    expect(content).toContain('lcm store');
    expect(content).not.toContain(LCM_MARKERS.START);
  });

  it('throws for hook type', () => {
    expect(() => generateContent(mockAgent, 'hook')).toThrow('Hook connectors are managed by the plugin system');
  });
});
