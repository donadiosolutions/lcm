export const REGRESSION_CANARIES = Object.freeze([
  "file://host.invalid?q=(file://host.invalid/Users/canary/private.db",
  "file://host.invalid?q=[a=b]file://host.invalid/Users/canary/private.db",
  "file://host.invalid?next=1file://host.invalid/Users/canary/private.db",
  "file://outer.invalid?q=prefix-file://host.invalid/Users/canary/private.db",
  "file://outer.invalid#q=prefix-file://host.invalid/Users/canary/private.db",
  "file://host\"name/Users/canary/private.db",
  "file://host'name/Users/canary/private.db",
]);

export const CONTRACT_CANARIES = Object.freeze({
  message: "incident-message-content-canary",
  summary: "incident-summary-content-canary",
  memory: "incident-memory-content-canary",
  tag: "incident-tag-content-canary",
  prompt: "incident-subtask-prompt-canary",
  inference: "incident-inference-content-canary",
  sqlParameter: "incident-sql-parameter-canary",
  utilityLiteral: "incident-utility-literal-canary",
  projectPath: "/private/incident-project-path-canary",
  urlPassword: "postgresql://runtime:incident-url-password-canary@host.invalid/lcm",
  clientKey: "-----BEGIN PRIVATE KEY-----incident-client-key-canary",
  caPem: "-----BEGIN CERTIFICATE-----\nINCIDENT_CA_BODY_CANARY\n-----END CERTIFICATE-----",
  caBody: "INCIDENT_CA_BODY_CANARY",
  providerKeys: "sk-incident-provider sk-ant-incident-provider ghp_incident_provider",
  applicationName: "incident-app-canary",
});

export const CANARY_CORPUS = Object.freeze([
  ...REGRESSION_CANARIES,
  ...Object.values(CONTRACT_CANARIES),
]);

export const CANARY_CLI_SURFACES = Object.freeze([
  ["status", ["status"]],
  ["status-json", ["status", "--json"]],
  ["doctor", ["doctor"]],
  ["doctor-verbose", ["doctor", "--verbose"]],
  ["stats", ["stats"]],
  ["stats-pool", ["stats", "--pool"]],
  ["events-status", ["events", "status"]],
]);

export function createCanaryWorkload(runId, machine) {
  return {
    hooks: CANARY_CORPUS.flatMap((canary, index) => [
      { id: `${runId}-canary-${machine}-prompt-${index}`, kind: "user-prompt", canary },
      { id: `${runId}-canary-${machine}-post-tool-${index}`, kind: "post-tool", canary },
    ]),
    stores: CANARY_CORPUS.map((canary, index) => ({
      id: `${runId}-canary-${machine}-store-${index}`,
      text: canary,
      tags: ["type:solution", "scope:project", CONTRACT_CANARIES.tag],
    })),
    searches: CANARY_CORPUS.map((canary, index) => ({ id: `${runId}-canary-${machine}-search-${index}`, query: canary })),
    utility: { id: `${runId}-canary-${machine}-utility`, sql: `SET application_name = '${CONTRACT_CANARIES.applicationName}'` },
    cli: CANARY_CLI_SURFACES.map(([surface, args]) => ({ id: `${runId}-canary-${machine}-cli-${surface}`, surface, args })),
  };
}
