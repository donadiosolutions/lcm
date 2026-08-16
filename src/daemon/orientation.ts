import { renderGuidance } from "../connectors/template-service.js";

// Content written to ~/.claude/lcm.md during install/doctor — loaded via CLAUDE.md @include.
// The canonical MCP rules template is the only recurring guidance source.
export const LCM_MD_CONTENT = renderGuidance("rules", "mcp");

// Guidance is now delivered via ~/.claude/lcm.md (installed by `lcm install` / `lcm doctor`),
// which CLAUDE.md includes via @lcm.md. No per-session injection needed.
export function buildOrientationPrompt(): string {
  return "";
}
