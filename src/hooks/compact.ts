import type { DaemonClient } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { normalizeTranscriptClient } from "../transcript-provider.js";
import { daemonPidPath } from "../runtime-paths.js";

export async function handlePreCompact(stdin: string, client: DaemonClient, port?: number): Promise<{ exitCode: number; stdout: string }> {
  const daemonPort = port ?? 3737;
  const pidFilePath = daemonPidPath();
  const { connected } = await ensureDaemon({ port: daemonPort, pidFilePath, spawnTimeoutMs: 5000 });
  if (!connected) return { exitCode: 0, stdout: "" };

  try {
    const input = JSON.parse(stdin || "{}");
    const clientName = normalizeTranscriptClient(input.client ?? process.env.LCM_CLIENT);
    const result = await client.post<{ summary: string; latestSummaryContent?: string }>("/compact", {
      ...input,
      client: clientName,
    });

    try {
      const { firePromoteEventsRequest } = await import("./session-end.js");
      firePromoteEventsRequest(daemonPort, { cwd: input.cwd });
    } catch {
      // Silent fail — PreCompact must not delay session
    }

    const parts: string[] = [];
    if (result.summary) parts.push(result.summary);
    if (result.latestSummaryContent) {
      const truncated = result.latestSummaryContent.length > 2000
        ? result.latestSummaryContent.slice(0, 2000) + "\n[truncated]"
        : result.latestSummaryContent;
      parts.push(truncated);
    }

    return { exitCode: 0, stdout: parts.join("\n\n") };
  } catch {
    return { exitCode: 0, stdout: "" };
  }
}
