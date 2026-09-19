import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";

import { redactPromptText } from "./issue-label-policy.mjs";

export const UNTRUSTED_ISSUE_DATA_START = "<<<LCM_UNTRUSTED_ISSUE_DATA>>>";
export const UNTRUSTED_ISSUE_DATA_END = "<<<END_LCM_UNTRUSTED_ISSUE_DATA>>>";
export const UNTRUSTED_ISSUE_DATA_LIMIT_BYTES = 65_536;

const REDACTED = "[REDACTED]";
const REDACTED_DELIMITER = "[REDACTED_UNTRUSTED_DELIMITER]";
const GITHUB_HOST = "github.com";
const GH_TIMEOUT_MS = 30_000;
const GH_MAX_OUTPUT_BYTES = 1_048_576;
const ISSUE_DATA_FIELDS = Object.freeze([
  "title",
  "body",
  "comments",
  "reproduction",
  "evidence",
]);
const TRUNCATION_SOURCE = "github-issue-view";
const TRUNCATION_REASON = "envelope-byte-limit";
const patternSources = Object.freeze({
  gitleaks: new URL("../../src/generated-patterns.ts", import.meta.url),
  native: new URL("../../src/scrub.ts", import.meta.url),
});
const runExecFile = promisify(execFile);
let trustedPatternsPromise;

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactKeys(value, expectedKeys, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object`);
  const expected = new Set(expectedKeys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw new Error(`${label} has an unsupported shape`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function assertIssueNumber(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function parseRepository(repository) {
  if (typeof repository !== "string") {
    throw new TypeError("Repository must be an owner/repository string");
  }
  const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*)$/u.exec(repository);
  if (!match) throw new TypeError("Repository must be an owner/repository string");
  return Object.freeze({ owner: match[1], repository: match[2], value: repository });
}

function validateIssueUrl(value, repository, issueNumber, label) {
  const url = assertNonEmptyString(value, `${label}.url`);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label}.url must be a canonical GitHub issue URL`);
  }
  const expectedPath = `/${repository.owner}/${repository.repository}/issues/${issueNumber}`;
  if (
    parsed.protocol !== "https:"
    || parsed.hostname.toLowerCase() !== GITHUB_HOST
    || parsed.search !== ""
    || parsed.hash !== ""
    || parsed.pathname.toLowerCase() !== expectedPath.toLowerCase()
  ) {
    throw new Error(`${label}.url must be a canonical GitHub issue URL`);
  }
  return url;
}

function nativeType(value, label) {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value) || typeof value.name !== "string" || value.name.length === 0) {
    throw new TypeError(`${label} must be a native issue type or null`);
  }
  return value.name;
}

function validateIssueIdentity(value, repository, expectedNumber, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object`);
  const number = assertIssueNumber(value.number, `${label}.number`);
  if (expectedNumber !== undefined && number !== expectedNumber) {
    throw new Error(`${label}.number did not match the requested issue`);
  }
  const nodeId = assertNonEmptyString(value.id, `${label}.id`);
  return Object.freeze({
    number,
    nodeId,
    url: validateIssueUrl(value.url, repository, number, label),
    nativeType: nativeType(value.issueType, `${label}.issueType`),
  });
}

function normalizeGitleaksRegex(source, flags) {
  let normalized = source
    .replace(/\[\[:alnum:\]\]/gu, "[A-Za-z0-9]")
    .replace(/\\z/gu, "$")
    .replace(/\(\?s:\.\)/gu, "[\\s\\S]");
  const needsIgnoreCase = flags.includes("i") || normalized.includes("(?i:");
  normalized = normalized.replace(/\(\?[i-]+:/gu, "(?:");
  return Object.freeze({ source: normalized, flags: needsIgnoreCase ? "i" : "" });
}

function declarationArray(sourceFile, name) {
  if (sourceFile.parseDiagnostics.length > 0) {
    throw new Error("Trusted redaction configuration could not be parsed");
  }
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name)
        && declaration.name.text === name
        && ts.isArrayLiteralExpression(declaration.initializer)
      ) {
        return declaration.initializer;
      }
    }
  }
  throw new Error("Trusted redaction configuration was incomplete");
}

function propertyMap(value, label) {
  if (!ts.isObjectLiteralExpression(value)) {
    throw new Error(`${label} must be an object literal`);
  }
  const result = new Map();
  for (const property of value.properties) {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error(`${label} contains an unsupported property`);
    }
    const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
      ? property.name.text
      : null;
    if (!name || result.has(name)) throw new Error(`${label} contains an unsupported property`);
    result.set(name, property.initializer);
  }
  return result;
}

function literalString(value, label) {
  if (!ts.isStringLiteral(value) && !ts.isNoSubstitutionTemplateLiteral(value)) {
    throw new Error(`${label} must be a string literal`);
  }
  return value.text;
}

function literalBoolean(value, label) {
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  throw new Error(`${label} must be a boolean literal`);
}

function readGitleaksPatterns(array) {
  return Object.freeze(array.elements.map((entry, index) => {
    const fields = propertyMap(entry, `Gitleaks pattern ${index}`);
    const expected = new Set(["id", "flags", "regex", "description", "keywords", "prefilter"]);
    if (fields.size !== expected.size || [...fields.keys()].some((key) => !expected.has(key))) {
      throw new Error("Trusted Gitleaks configuration was incomplete");
    }
    const id = literalString(fields.get("id"), `Gitleaks pattern ${index}.id`);
    const flags = literalString(fields.get("flags"), `Gitleaks pattern ${index}.flags`);
    const regex = literalString(fields.get("regex"), `Gitleaks pattern ${index}.regex`);
    literalString(fields.get("description"), `Gitleaks pattern ${index}.description`);
    const keywords = fields.get("keywords");
    if (!ts.isArrayLiteralExpression(keywords)) {
      throw new Error(`Gitleaks pattern ${index}.keywords must be an array literal`);
    }
    for (const keyword of keywords.elements) {
      literalString(keyword, `Gitleaks pattern ${index}.keywords`);
    }
    literalBoolean(fields.get("prefilter"), `Gitleaks pattern ${index}.prefilter`);
    if (!/^[i]*$/u.test(flags)) {
      throw new Error(`Gitleaks pattern ${id} uses unsupported flags`);
    }
    const normalized = normalizeGitleaksRegex(regex, flags);
    try {
      return Object.freeze({
        id,
        regex: new RegExp(normalized.source, `g${normalized.flags}`),
      });
    } catch {
      throw new Error(`Gitleaks pattern ${id} cannot be compiled safely`);
    }
  }));
}

function readNativePatterns(array) {
  return Object.freeze(array.elements.map((entry, index) => {
    const source = literalString(entry, `Native pattern ${index}`);
    try {
      return Object.freeze({ id: `native-${index}`, regex: new RegExp(source, "g") });
    } catch {
      throw new Error(`Native pattern ${index} cannot be compiled safely`);
    }
  }));
}

async function loadTrustedPatterns() {
  const [gitleaksSource, nativeSource] = await Promise.all([
    readFile(patternSources.gitleaks, "utf8"),
    readFile(patternSources.native, "utf8"),
  ]);
  const gitleaks = declarationArray(
    ts.createSourceFile("generated-patterns.ts", gitleaksSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
    "GITLEAKS_PATTERNS",
  );
  const native = declarationArray(
    ts.createSourceFile("scrub.ts", nativeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
    "NATIVE_PATTERNS",
  );
  return Object.freeze([...readGitleaksPatterns(gitleaks), ...readNativePatterns(native)]);
}

function trustedPatterns() {
  if (!trustedPatternsPromise) trustedPatternsPromise = loadTrustedPatterns();
  return trustedPatternsPromise;
}

function redactWithPattern(value, pattern) {
  pattern.regex.lastIndex = 0;
  let match;
  while ((match = pattern.regex.exec(value)) !== null) {
    if (match[0].length === 0) {
      throw new Error(`Trusted redaction pattern ${pattern.id} matched without consuming input`);
    }
  }
  pattern.regex.lastIndex = 0;
  return value.replace(pattern.regex, REDACTED);
}

async function redactIssueString(value) {
  let redacted;
  try {
    redacted = redactPromptText(value, Number.MAX_SAFE_INTEGER);
    for (const pattern of await trustedPatterns()) {
      redacted = redactWithPattern(redacted, pattern);
    }
  } catch {
    throw new Error("Trusted issue redaction configuration is unavailable");
  }
  return redacted
    .replaceAll(UNTRUSTED_ISSUE_DATA_START, REDACTED_DELIMITER)
    .replaceAll(UNTRUSTED_ISSUE_DATA_END, REDACTED_DELIMITER);
}

async function projectJsonValue(value, ancestors) {
  if (typeof value === "string") return redactIssueString(value);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error("Issue data contains a cycle");
    ancestors.add(value);
    try {
      return Promise.all(value.map((item) => projectJsonValue(item, ancestors)));
    } finally {
      ancestors.delete(value);
    }
  }
  if (!isPlainObject(value)) throw new TypeError("Issue data contains an unsupported value");
  if (ancestors.has(value)) throw new Error("Issue data contains a cycle");
  ancestors.add(value);
  try {
    const projected = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      const projectedKey = await redactIssueString(key);
      if (Object.hasOwn(projected, projectedKey)) {
        throw new Error("Issue data redaction produced duplicate object keys");
      }
      projected[projectedKey] = await projectJsonValue(item, ancestors);
    }
    return projected;
  } finally {
    ancestors.delete(value);
  }
}

function wrappedEnvelope(payload) {
  return `${UNTRUSTED_ISSUE_DATA_START}\n${JSON.stringify(payload)}\n${UNTRUSTED_ISSUE_DATA_END}`;
}

function truncationPayload(data, originalBytes, retainedBytes) {
  return {
    title: data.title,
    body: data.body,
    comments: data.comments,
    reproduction: data.reproduction,
    evidence: data.evidence,
    truncation: {
      applied: true,
      source: TRUNCATION_SOURCE,
      reason: TRUNCATION_REASON,
      originalBytes,
      retainedBytes,
    },
  };
}

function envelopeBytes(payload) {
  return Buffer.byteLength(wrappedEnvelope(payload), "utf8");
}

function truncateUtf8(value, maximumBytes) {
  let retained = "";
  let retainedBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (retainedBytes + characterBytes > maximumBytes) break;
    retained += character;
    retainedBytes += characterBytes;
  }
  for (const marker of [REDACTED_DELIMITER, REDACTED]) {
    for (let length = marker.length - 1; length > 0; length -= 1) {
      if (retained.endsWith(marker.slice(0, length))) {
        retained = retained.slice(0, -length);
        break;
      }
    }
  }
  return retained;
}

function renderTruncatedEnvelope(data, originalBytes, retainedBytes) {
  return wrappedEnvelope(truncationPayload(data, originalBytes, retainedBytes));
}

function truncateScalarToFit(data, field, originalBytes) {
  const current = data[field];
  let low = 0;
  let high = Buffer.byteLength(current, "utf8");
  let best;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    data[field] = truncateUtf8(current, middle);
    const bytes = Buffer.byteLength(
      renderTruncatedEnvelope(data, originalBytes, UNTRUSTED_ISSUE_DATA_LIMIT_BYTES),
      "utf8",
    );
    if (bytes <= UNTRUSTED_ISSUE_DATA_LIMIT_BYTES) {
      best = data[field];
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best === undefined) {
    throw new Error("Issue data cannot fit in a bounded envelope");
  }
  data[field] = best;
}

function boundedEnvelope(data) {
  const untruncated = {
    title: data.title,
    body: data.body,
    comments: data.comments,
    reproduction: data.reproduction,
    evidence: data.evidence,
    truncation: { applied: false },
  };
  const originalBytes = envelopeBytes(untruncated);
  if (originalBytes <= UNTRUSTED_ISSUE_DATA_LIMIT_BYTES) return wrappedEnvelope(untruncated);

  const bounded = {
    title: data.title,
    body: data.body,
    comments: [...data.comments],
    reproduction: [...data.reproduction],
    evidence: [...data.evidence],
  };
  const maximumSize = () => Buffer.byteLength(
    renderTruncatedEnvelope(bounded, originalBytes, UNTRUSTED_ISSUE_DATA_LIMIT_BYTES),
    "utf8",
  );
  for (const field of ["evidence", "reproduction", "comments"]) {
    while (bounded[field].length > 0 && maximumSize() > UNTRUSTED_ISSUE_DATA_LIMIT_BYTES) {
      bounded[field].pop();
    }
  }
  for (const field of ["body", "title"]) {
    if (maximumSize() > UNTRUSTED_ISSUE_DATA_LIMIT_BYTES) {
      truncateScalarToFit(bounded, field, originalBytes);
    }
  }
  if (maximumSize() > UNTRUSTED_ISSUE_DATA_LIMIT_BYTES) {
    throw new Error("Issue data cannot fit in a bounded envelope");
  }

  let retainedBytes = UNTRUSTED_ISSUE_DATA_LIMIT_BYTES;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const envelope = renderTruncatedEnvelope(bounded, originalBytes, retainedBytes);
    const actualBytes = Buffer.byteLength(envelope, "utf8");
    if (actualBytes > UNTRUSTED_ISSUE_DATA_LIMIT_BYTES) {
      throw new Error("Issue data cannot fit in a bounded envelope");
    }
    if (actualBytes === retainedBytes) return envelope;
    retainedBytes = actualBytes;
  }
  throw new Error("Issue data truncation metadata did not stabilize");
}

export async function projectUntrustedIssueData(value) {
  assertExactKeys(value, ISSUE_DATA_FIELDS, "Issue data");
  if (typeof value.title !== "string" || typeof value.body !== "string") {
    throw new TypeError("Issue title and body must be strings");
  }
  for (const field of ["comments", "reproduction", "evidence"]) {
    if (!Array.isArray(value[field])) throw new TypeError(`Issue ${field} must be an array`);
  }
  const ancestors = new WeakSet();
  const data = {
    title: await redactIssueString(value.title),
    body: await redactIssueString(value.body),
    comments: await projectJsonValue(value.comments, ancestors),
    reproduction: await projectJsonValue(value.reproduction, ancestors),
    evidence: await projectJsonValue(value.evidence, ancestors),
  };
  return boundedEnvelope(data);
}

async function defaultRunCommand({ command, args, maxOutputBytes, timeoutMs }) {
  const { stdout } = await runExecFile(command, args, {
    encoding: "utf8",
    env: { ...process.env, GH_HOST: GITHUB_HOST },
    maxBuffer: maxOutputBytes,
    timeout: timeoutMs,
    windowsHide: true,
  });
  return stdout;
}

function parseTransportResponse(value, repository, issueNumber) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > GH_MAX_OUTPUT_BYTES) {
    throw new Error("Trusted Bug-campaign transport returned an invalid response");
  }
  let response;
  try {
    response = JSON.parse(value);
  } catch {
    throw new Error("Trusted Bug-campaign transport returned an invalid response");
  }
  if (!isPlainObject(response)) {
    throw new Error("Trusted Bug-campaign transport returned an invalid response");
  }
  const issue = validateIssueIdentity(response, repository, issueNumber, "Issue");
  if (response.state !== "OPEN" || issue.nativeType !== "Bug") {
    throw new Error("Issue must be an open native Bug for this campaign");
  }
  if (typeof response.title !== "string" || (response.body !== null && typeof response.body !== "string")) {
    throw new Error("Trusted Bug-campaign transport returned an invalid response");
  }
  let parent = null;
  if (response.parent !== null && response.parent !== undefined) {
    parent = validateIssueIdentity(response.parent, repository, undefined, "Issue parent");
  }
  return Object.freeze({
    trustedIssue: Object.freeze({
      host: GITHUB_HOST,
      repository: repository.value,
      ...issue,
      parent,
    }),
    issueData: {
      title: response.title,
      body: response.body ?? "",
      comments: [],
      reproduction: [],
      evidence: [],
    },
  });
}

export async function fetchBugCampaignIssue({ repository, issueNumber, runCommand = defaultRunCommand }) {
  const parsedRepository = parseRepository(repository);
  const number = assertIssueNumber(issueNumber, "Issue number");
  if (typeof runCommand !== "function") throw new TypeError("Transport runner must be a function");
  let rawResponse;
  try {
    rawResponse = await runCommand({
      command: "gh",
      args: [
        "issue",
        "view",
        String(number),
        "--repo",
        `${GITHUB_HOST}/${parsedRepository.value}`,
        "--json",
        "id,number,url,issueType,parent,state,title,body",
      ],
      maxOutputBytes: GH_MAX_OUTPUT_BYTES,
      timeoutMs: GH_TIMEOUT_MS,
    });
  } catch {
    throw new Error("Trusted Bug-campaign transport failed");
  }
  const parsed = parseTransportResponse(rawResponse, parsedRepository, number);
  return Object.freeze({
    trustedIssue: parsed.trustedIssue,
    untrustedIssueData: await projectUntrustedIssueData(parsed.issueData),
  });
}

function parseCliArguments(argumentsList) {
  if (!Array.isArray(argumentsList) || argumentsList.length !== 4) {
    throw new Error("Usage: --repository OWNER/REPOSITORY --issue-number NUMBER");
  }
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if ((name !== "--repository" && name !== "--issue-number") || values.has(name) || typeof value !== "string") {
      throw new Error("Usage: --repository OWNER/REPOSITORY --issue-number NUMBER");
    }
    values.set(name, value);
  }
  const rawNumber = values.get("--issue-number");
  if (!/^\d+$/u.test(rawNumber)) {
    throw new Error("Usage: --repository OWNER/REPOSITORY --issue-number NUMBER");
  }
  return Object.freeze({ repository: values.get("--repository"), issueNumber: Number(rawNumber) });
}

export async function runBugCampaignIntakeCli(argumentsList, {
  runCommand = defaultRunCommand,
  write = (chunk) => process.stdout.write(chunk),
} = {}) {
  if (typeof write !== "function") throw new TypeError("Output writer must be a function");
  const { repository, issueNumber } = parseCliArguments(argumentsList);
  const projection = await fetchBugCampaignIssue({ repository, issueNumber, runCommand });
  write(`${JSON.stringify(projection)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runBugCampaignIntakeCli(process.argv.slice(2)).catch(() => {
    process.stderr.write("Bug-campaign intake failed without exposing issue data.\n");
    process.exitCode = 1;
  });
}
