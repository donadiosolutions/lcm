import { connect, createServer, type AddressInfo, type Socket } from "node:net";

/** Totals of every connection a {@link RoundTripRelay} has carried so far. */
export interface RoundTripCounts {
  /** Connections accepted. */
  readonly connections: number;
  /**
   * Times a connection's traffic turned to client-to-server, counting its
   * first client bytes as a turn. Awaited requests on one connection are
   * serialized, so these are its request/response exchanges, TLS and
   * authentication included.
   */
  readonly turns: number;
}

export interface RoundTripRelay {
  readonly port: number;
  counts(): RoundTripCounts;
  /** Resolves once no carried connection is open. */
  quiescent(): Promise<void>;
  close(): Promise<void>;
}

/** The connection target of a PostgreSQL URL, without its brackets or a default port. */
export function postgreSqlUrlTarget(url: string): { readonly host: string; readonly port: number } {
  const target = new URL(url);
  return {
    host: target.hostname.replace(/^\[|\]$/gu, ""),
    port: target.port === "" ? 5432 : Number(target.port),
  };
}

/**
 * The same URL pointed at the relay. The harness certificate also names
 * 127.0.0.1, so certificate verification against the rewritten host still
 * passes and TLS stays end to end.
 */
export function viaRoundTripRelay(url: string, relay: Pick<RoundTripRelay, "port">): string {
  const relayed = new URL(url);
  relayed.hostname = "127.0.0.1";
  relayed.port = String(relay.port);
  return relayed.toString();
}

/**
 * A zero-delay TCP relay in front of PostgreSQL. It forwards every byte
 * unchanged and counts a turn whenever a connection's traffic changes
 * direction to client-to-server, the rule the #1869 latency measurements use.
 */
export async function startRoundTripRelay(
  target: { readonly host: string; readonly port: number },
): Promise<RoundTripRelay> {
  let connections = 0;
  let turns = 0;
  const open = new Set<Socket>();
  const idleWaiters: Array<() => void> = [];
  const settleIdle = (): void => {
    if (open.size > 0) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  };
  const server = createServer({ allowHalfOpen: true }, (client) => {
    connections += 1;
    const upstream = connect({ host: target.host, port: target.port, allowHalfOpen: true });
    let last: "client" | "server" | undefined;
    for (const socket of [client, upstream]) {
      open.add(socket);
      socket.setNoDelay(true);
      socket.on("error", () => { client.destroy(); upstream.destroy(); });
      socket.on("close", () => {
        open.delete(socket);
        client.destroy();
        upstream.destroy();
        settleIdle();
      });
    }
    client.on("data", () => {
      if (last !== "client") turns += 1;
      last = "client";
    });
    upstream.on("data", () => { last = "server"; });
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { resolve(); });
  });
  return {
    port: (server.address() as AddressInfo).port,
    counts: () => ({ connections, turns }),
    quiescent: () => new Promise<void>((resolve) => {
      idleWaiters.push(resolve);
      settleIdle();
    }),
    close: async () => {
      for (const socket of open) socket.destroy();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    },
  };
}
