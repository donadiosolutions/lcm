import { describe, expect, it } from 'vitest';
import { LCM_OPERATION_CATALOG } from '../../src/connectors/operation-catalog.js';
import { getMcpToolDefinitions } from '../../src/mcp/server.js';

describe('LCM operation catalog', () => {
  it('keeps canonical operation and CLI/MCP spellings explicit', () => {
    expect(
      LCM_OPERATION_CATALOG.map(({ name, cli, mcp }) => ({ name, cli, mcp })),
    ).toEqual([
      { name: 'search', cli: 'lcm search "query"', mcp: 'lcm_search' },
      { name: 'grep', cli: 'lcm grep "pattern" --mode regex', mcp: 'lcm_grep' },
      { name: 'describe', cli: 'lcm describe <nodeId>', mcp: 'lcm_describe' },
      { name: 'expand', cli: 'lcm expand <nodeId> --depth N', mcp: 'lcm_expand' },
      { name: 'store', cli: 'lcm store "memory with rationale"', mcp: 'lcm_store' },
      { name: 'doctor', cli: 'lcm doctor', mcp: 'lcm_doctor' },
      { name: 'stats', cli: 'lcm stats', mcp: 'lcm_stats' },
    ]);
  });

  it('records concise purposes and lifecycle triggers without duplicating MCP schemas', () => {
    for (const operation of LCM_OPERATION_CATALOG) {
      expect(operation.purpose.trim().length).toBeGreaterThan(0);
      expect(operation.lifecycleTrigger.trim().length).toBeGreaterThan(0);
      expect(Object.keys(operation).sort()).toEqual([
        'cli',
        'lifecycleTrigger',
        'mcp',
        'name',
        'purpose',
      ]);
      expect(operation).not.toHaveProperty('inputSchema');
      expect(operation).not.toHaveProperty('description');
    }
  });

  it('stays name-parity-correct with the authoritative MCP registrations', () => {
    const catalogNames = LCM_OPERATION_CATALOG.map(({ mcp }) => mcp).sort();
    const registeredNames = getMcpToolDefinitions().map(({ name }) => name).sort();

    expect(catalogNames).toEqual(registeredNames);
  });
});
