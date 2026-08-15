import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as templateService from '../../src/connectors/template-service.js';
import { LCM_MARKERS } from '../../src/connectors/constants.js';
import type { Agent } from '../../src/connectors/types.js';

const {
  generateContent,
  generateRulesContent,
  generateSkillContent,
} = templateService;

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

const durableStorageRequirement =
  'Agents MUST immediately store every newly recognized durable decision, preference, root cause, pattern, gotcha, solution, and reusable workflow, including its rationale.';
const feedbackCliFallback =
  '`lcm store "memory-used feedback" --tag signal:memory_used --tag memory_id:<actual-id>`';

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function expectLeanBindingGuidance(content: string): void {
  expect(content).toContain(durableStorageRequirement);
  expect(content).toContain('Automatic/passive capture is complementary and never a substitute');
  expect(content).toContain('Use automatically injected memory first');
  expect(content).toContain('only when injected context is absent or insufficient');
  expect(content).toContain('`lcm_store`');
  expect(content).toContain('`signal:memory_used` and `memory_id:<actual-id>`');
  expect(content).toContain(feedbackCliFallback);

  for (const category of [
    'decision',
    'preference',
    'root cause',
    'pattern',
    'gotcha',
    'solution',
    'reusable workflow',
  ]) {
    expect(content).toContain(category);
  }

  expect(content).toContain('including its rationale');
  expect(content).toContain('only on demand');
  expect(content).toContain('lcm_describe');
  expect(content).toContain('lcm_expand');
  expect(content).toContain('lcm_doctor');

  for (const excluded of [
    /\bimport\b/iu,
    /\bdiagnose\b/iu,
    /\bstats\b/iu,
    /\blcm_stats\b/iu,
    /Tag conventions/iu,
    /\brestart\b/iu,
    /\brecovery loop\b/iu,
    /connectors install/iu,
    /\bserializ(?:e|ed|ation)\b/iu,
    /one (?:read|operation) at a time/iu,
    /## (?:Available Commands|Decision Table|Error Handling)/iu,
    /lcm --help/iu,
  ]) {
    expect(content).not.toMatch(excluded);
  }
}

describe('generateRulesContent', () => {
  it('renders one deterministic managed fallback whose body starts with the parser heading', () => {
    const first = generateRulesContent(mockAgent);
    const second = generateRulesContent(mockAgent);

    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
    expect(first).toContain(`${LCM_MARKERS.START}\n# Workflow Instruction`);
    expect(first.slice(first.indexOf(LCM_MARKERS.START))).toMatch(
      /^<!-- lcm -->\n# Workflow Instruction/u,
    );
    expect(first).toContain(LCM_MARKERS.END);
    expect(countOccurrences(first, LCM_MARKERS.START)).toBe(2);
    expect(first).not.toMatch(/\{\{[^}]+\}\}/u);
  });

  it('includes an agent header only when configured', () => {
    expect(generateRulesContent(mockAgentWithHeader)).toContain('trigger: always_on');
    expect(generateRulesContent(mockAgent)).not.toContain('trigger:');
  });

  it('enforces the lean durable-memory policy without excluded operational bloat', () => {
    expectLeanBindingGuidance(generateRulesContent(mockAgent));
  });

  it('omits legacy markers, footer tags, separators, and agent-specific prose', () => {
    const content = generateRulesContent(mockAgent);

    expect(content).not.toContain('LCM_CONNECTOR_START');
    expect(content).not.toContain('LCM_CONNECTOR_END');
    expect(content).not.toContain('@lcm');
    expect(content).not.toContain('Test Agent');
    expect(content).not.toContain('\n---\n');
    expect(content).not.toContain('You are a coding agent.');
  });

  it('keeps Codex generated rules free of Claude-specific text', () => {
    expect(generateRulesContent(codexAgent)).not.toMatch(/claude/iu);
  });
});

describe('generateSkillContent', () => {
  it('renders deterministically and remains byte-identical to the canonical packaged skill', () => {
    const canonical = readFileSync(
      new URL('../../src/connectors/templates/skill/SKILL.md', import.meta.url),
      'utf8',
    );
    const first = generateSkillContent(mockAgent);
    const second = generateSkillContent(codexAgent);

    expect(canonical.endsWith('\n')).toBe(true);
    expect(canonical.endsWith('\n\n')).toBe(false);
    expect(Buffer.from(first).equals(Buffer.from(canonical))).toBe(true);
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
  });

  it('makes immediate durable storage binding in both discovery metadata and the body', () => {
    const content = generateSkillContent(mockAgent);
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/u)?.[1];
    const body = content.replace(/^---\n[\s\S]*?\n---\n/u, '');

    expect(frontmatter).toContain(durableStorageRequirement);
    expect(body).toContain(durableStorageRequirement);
    expectLeanBindingGuidance(body);
  });

  it('shares the exact catalog-rendered operational wording with the rules fallback', () => {
    const skillGuidance = generateSkillContent(mockAgent).match(
      /# Long Context Manager \(LCM\)\n\n([\s\S]*?)\n$/u,
    )?.[1];
    const rulesGuidance = generateRulesContent(mockAgent).match(
      /# Workflow Instruction\n\n([\s\S]*?)\n<!-- lcm -->$/u,
    )?.[1];

    expect(skillGuidance).toBeDefined();
    expect(rulesGuidance).toBe(skillGuidance);
  });

  it('is a standalone lcm-memory skill without connector markers or agent-specific prose', () => {
    const content = generateSkillContent(codexAgent);

    expect(content).toContain('name: lcm-memory');
    expect(content).not.toContain(LCM_MARKERS.START);
    expect(content).not.toContain(LCM_MARKERS.END);
    expect(content).not.toMatch(/claude/iu);
  });
});

describe('generateContent dispatch', () => {
  it('delegates rules and skill rendering', () => {
    expect(generateContent(mockAgent, 'rules')).toBe(generateRulesContent(mockAgent));
    expect(generateContent(mockAgent, 'skill')).toBe(generateSkillContent(mockAgent));
  });

  it('throws for hook type', () => {
    expect(() => generateContent(mockAgent, 'hook')).toThrow(
      'Hook connectors are managed by the structured connector installer',
    );
  });

  it('does not expose the retired MCP template generator', () => {
    expect(templateService).not.toHaveProperty('generateMcpContent');
  });
});
