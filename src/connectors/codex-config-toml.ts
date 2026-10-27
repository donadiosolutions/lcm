// src/connectors/codex-config-toml.ts
// Conservative reader for the parts of Codex's config.toml that LCM needs:
// the hooks feature flag and per-hook state ([hooks.state."<key>"]).
// Anything this scanner cannot classify is reported as unknown; it never guesses.

export interface CodexHookStateFields {
  enabled?: boolean | "unknown";
  trustedHash?: string | "unknown";
}

export interface CodexTomlScan {
  /** False when the document could not be tokenised; every derived fact is then unknown. */
  readonly valid: boolean;
  readonly featureHooks?: boolean;
  readonly featureAlias?: boolean;
  readonly featureUnknown: boolean;
  readonly states: ReadonlyMap<string, CodexHookStateFields>;
  readonly statesUnknown: boolean;
  readonly featuresHeaderCount: number;
  /** features defined by dotted keys or an inline table outside a [features] header. */
  readonly featuresInlineOrDotted: boolean;
  /** Offset just after the last statement of the first [features] header table. */
  readonly featuresInsertOffset?: number;
}

export type CodexHooksFeatureClass = "absent" | "explicit-true" | "explicit-false" | "unrecognized";

type TomlValue =
  | { kind: "bool"; value: boolean }
  | { kind: "string"; value: string }
  | { kind: "other" }
  | { kind: "complex"; inlineTable?: TomlNode };

/** Declaration tree used to reject documents a TOML parser would reject (redeclared tables, duplicate keys). */
interface TomlNode {
  kind: "table" | "array" | "value";
  children: Map<string, TomlNode>;
  items: TomlNode[];
  implicit: boolean;
  explicit: boolean;
  dotted: boolean;
  inline: boolean;
}

const newNode = (kind: TomlNode["kind"], over: Partial<TomlNode> = {}): TomlNode => ({
  kind, children: new Map(), items: [], implicit: false, explicit: false, dotted: false, inline: false, ...over,
});

class TomlSyntaxError extends Error {}

function fail(): never {
  throw new TomlSyntaxError("unsupported TOML");
}

const MAX_DEPTH = 64;
const BARE_KEY = /[A-Za-z0-9_-]+/y;
// Characters TOML forbids raw in strings and comments (tab is allowed; newlines are handled by callers).
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/;
const INTEGER = /^[+-]?(?:0|[1-9](?:_?\d)*)$/;
const FLOAT = /^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?$/;
const RADIX_INTEGER = /^0(?:x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|o[0-7](?:_?[0-7])*|b[01](?:_?[01])*)$/;
const SPECIAL_FLOAT = /^[+-]?(?:inf|nan)$/;
const DATE_TIME = /^(\d{4})-(\d\d)-(\d\d)(?:[Tt ](\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:[Zz]|[+-](\d\d):(\d\d))?)?$/;
const LOCAL_TIME = /^(\d\d):(\d\d):(\d\d)(?:\.\d+)?$/;
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\u001b", '"': '"', "\\": "\\",
};

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Value-domain check for a scalar token (the ranges toml/toml_datetime enforce, not just its shape). */
function validScalar(token: string): boolean {
  if (INTEGER.test(token) || RADIX_INTEGER.test(token)) {
    const value = BigInt(token.replaceAll("_", ""));
    return value >= I64_MIN && value <= I64_MAX;
  }
  if (FLOAT.test(token)) return Number.isFinite(Number(token.replaceAll("_", "")));
  if (SPECIAL_FLOAT.test(token)) return true;
  const time = LOCAL_TIME.exec(token);
  if (time !== null) return Number(time[1]) <= 23 && Number(time[2]) <= 59 && Number(time[3]) <= 60;
  const date = DATE_TIME.exec(token);
  if (date === null) return false;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = date;
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > daysInMonth(Number(year), Number(month))) {
    return false;
  }
  return (hour === undefined || (Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 60))
    && (offsetHour === undefined || (Number(offsetHour) <= 23 && Number(offsetMinute) <= 59));
}

function isBareChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_-]/.test(char);
}

function startsWithPath(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((part, index) => path[index] === part);
}

function parseTomlDocument(src: string): CodexTomlScan {
  const n = src.length;
  let pos = 0;
  let depth = 0;
  let table: string[] = [];
  const root = newNode("table");
  let current = root;
  let inFeaturesHeader = false;
  let featureHooks: boolean | undefined;
  let featureAlias: boolean | undefined;
  let featureUnknown = false;
  let statesUnknown = false;
  let featuresHeaderCount = 0;
  let featuresInlineOrDotted = false;
  let featuresInsertOffset: number | undefined;
  const states = new Map<string, CodexHookStateFields>();

  const skipSpaces = (): void => {
    while (pos < n && (src[pos] === " " || src[pos] === "\t")) pos++;
  };
  const skipComment = (): void => {
    if (src[pos] !== "#") return;
    pos++;
    while (pos < n && src[pos] !== "\n") {
      if (src[pos] === "\r") {
        // A carriage return is only valid as the start of CRLF, which the caller consumes.
        if (src[pos + 1] !== "\n") fail();
        return;
      }
      if (CONTROL.test(src[pos])) fail();
      pos++;
    }
  };
  const skipTrivia = (): void => {
    for (;;) {
      skipSpaces();
      skipComment();
      if (src[pos] === "\n") pos++;
      else if (src[pos] === "\r" && src[pos + 1] === "\n") pos += 2;
      else return;
    }
  };
  const endOfLine = (): void => {
    skipSpaces();
    skipComment();
    if (pos >= n) return;
    if (src[pos] === "\n") pos++;
    else if (src[pos] === "\r" && src[pos + 1] === "\n") pos += 2;
    else fail();
  };

  const hex = (length: number): string => {
    const digits = src.slice(pos + 1, pos + 1 + length);
    if (digits.length !== length || !/^[0-9A-Fa-f]+$/.test(digits)) fail();
    const code = Number.parseInt(digits, 16);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) fail();
    pos += length;
    return String.fromCodePoint(code);
  };

  // Decode one escape sequence; pos is on the character after the backslash and is left on the escape's last character.
  const escapeSequence = (): string => {
    const escape = src[pos];
    if (escape === "x") return hex(2);
    if (escape === "u") return hex(4);
    if (escape === "U") return hex(8);
    if (escape !== undefined && Object.hasOwn(SIMPLE_ESCAPES, escape)) return SIMPLE_ESCAPES[escape];
    return fail();
  };

  const parseBasicString = (): string => {
    pos++;
    let out = "";
    for (;;) {
      if (pos >= n) fail();
      const char = src[pos];
      if (char === '"') {
        pos++;
        return out;
      }
      if (CONTROL.test(char)) fail();
      if (char === "\\") {
        pos++;
        out += escapeSequence();
      } else {
        out += char;
      }
      pos++;
    }
  };

  const parseLiteralString = (): string => {
    pos++;
    const start = pos;
    while (pos < n && src[pos] !== "'" && !CONTROL.test(src[pos])) pos++;
    if (src[pos] !== "'") fail();
    const out = src.slice(start, pos);
    pos++;
    return out;
  };

  const skipMultiline = (quote: '"' | "'"): void => {
    const delimiter = quote.repeat(3);
    pos += 3;
    for (;;) {
      if (pos >= n) fail();
      if (src.startsWith(delimiter, pos)) {
        pos += 3;
        for (let extra = 0; extra < 2 && src[pos] === quote; extra++) pos++;
        return;
      }
      const char = src[pos];
      if (char === "\n") {
        pos++;
      } else if (char === "\r") {
        if (src[pos + 1] !== "\n") fail();
        pos += 2;
      } else if (CONTROL.test(char)) {
        fail();
      } else if (quote === '"' && char === "\\") {
        pos++;
        // A backslash before optional blanks and a newline trims the following whitespace.
        let probe = pos;
        while (src[probe] === " " || src[probe] === "\t") probe++;
        if (src[probe] === "\n") pos = probe + 1;
        else if (src[probe] === "\r" && src[probe + 1] === "\n") pos = probe + 2;
        else {
          escapeSequence();
          pos++;
        }
      } else {
        pos++;
      }
    }
  };

  const parseSimpleKey = (): string => {
    const char = src[pos];
    if (char === '"') {
      if (src.startsWith('"""', pos)) fail();
      return parseBasicString();
    }
    if (char === "'") {
      if (src.startsWith("'''", pos)) fail();
      return parseLiteralString();
    }
    BARE_KEY.lastIndex = pos;
    const match = BARE_KEY.exec(src);
    if (match === null) fail();
    pos += match[0].length;
    return match[0];
  };

  const parseKeyPath = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      skipSpaces();
      parts.push(parseSimpleKey());
      skipSpaces();
      if (src[pos] !== ".") return parts;
      pos++;
    }
  };

  const descend = (node: TomlNode): TomlNode => {
    const target = node.kind === "array" ? node.items[node.items.length - 1] : node;
    if (target.inline) fail();
    return target;
  };

  // Dotted assignment into a table node. A key may be defined once, and only
  // tables created by dotted keys may be extended by dotted keys.
  const assign = (start: TomlNode, keys: string[], value: TomlValue): void => {
    let node = descend(start);
    for (const part of keys.slice(0, -1)) {
      let child = node.children.get(part);
      if (child === undefined) {
        child = newNode("table", { dotted: true });
        node.children.set(part, child);
      } else if (child.kind !== "table" || !child.dotted || child.inline) {
        fail();
      }
      node = child;
    }
    const last = keys[keys.length - 1];
    if (node.children.has(last)) fail();
    node.children.set(last, value.kind === "complex" && value.inlineTable !== undefined
      ? value.inlineTable
      : newNode("value"));
  };

  const declareHeader = (path: string[], isArray: boolean): TomlNode => {
    let node = root;
    path.forEach((part, index) => {
      const parent = descend(node);
      let child = parent.children.get(part);
      if (index < path.length - 1) {
        if (child === undefined) {
          child = newNode("table", { implicit: true });
          parent.children.set(part, child);
        } else if (child.kind === "value") {
          fail();
        }
      } else if (isArray) {
        if (child === undefined) {
          child = newNode("array");
          parent.children.set(part, child);
        } else if (child.kind !== "array") {
          fail();
        }
        child.items.push(newNode("table", { explicit: true }));
      } else if (child === undefined) {
        child = newNode("table", { explicit: true });
        parent.children.set(part, child);
      } else if (child.kind === "table" && child.implicit && !child.explicit && !child.dotted && !child.inline) {
        child.explicit = true;
      } else {
        fail();
      }
      node = child;
    });
    return descend(node);
  };

  const parseValue = (): TomlValue => {
    if (++depth > MAX_DEPTH) fail();
    try {
      const char = src[pos];
      if (char === '"') {
        if (src.startsWith('"""', pos)) {
          skipMultiline('"');
          return { kind: "other" };
        }
        return { kind: "string", value: parseBasicString() };
      }
      if (char === "'") {
        if (src.startsWith("'''", pos)) {
          skipMultiline("'");
          return { kind: "other" };
        }
        return { kind: "string", value: parseLiteralString() };
      }
      if (char === "[") {
        pos++;
        for (;;) {
          skipTrivia();
          if (src[pos] === "]") {
            pos++;
            return { kind: "complex" };
          }
          parseValue();
          skipTrivia();
          if (src[pos] === ",") pos++;
          else if (src[pos] !== "]") fail();
        }
      }
      if (char === "{") {
        pos++;
        const inlineTable = newNode("table");
        for (;;) {
          skipTrivia();
          if (src[pos] === "}") {
            pos++;
            inlineTable.inline = true;
            return { kind: "complex", inlineTable };
          }
          const keys = parseKeyPath();
          skipSpaces();
          if (src[pos] !== "=") fail();
          pos++;
          skipSpaces();
          assign(inlineTable, keys, parseValue());
          skipTrivia();
          if (src[pos] === ",") pos++;
          else if (src[pos] !== "}") fail();
        }
      }
      for (const literal of ["true", "false"] as const) {
        if (src.startsWith(literal, pos) && !isBareChar(src[pos + literal.length])) {
          pos += literal.length;
          return { kind: "bool", value: literal === "true" };
        }
      }
      const start = pos;
      while (pos < n && !/[\s,\]}#]/.test(src[pos])) pos++;
      let token = src.slice(start, pos);
      if (/^\d{4}-\d\d-\d\d$/.test(token) && src[pos] === " " && /\d/.test(src[pos + 1] ?? "")) {
        const from = ++pos;
        while (pos < n && /[0-9:.+\-Zz]/.test(src[pos])) pos++;
        token += " " + src.slice(from, pos);
      }
      // An unvalidated token is not evidence of a valid document.
      if (!validScalar(token)) fail();
      return { kind: "other" };
    } finally {
      depth--;
    }
  };

  const setStateField = (
    key: string,
    field: "enabled" | "trustedHash",
    value: boolean | string,
  ): void => {
    const trimmed = key.trim();
    const fields: CodexHookStateFields = states.get(trimmed) ?? {};
    (fields as Record<string, boolean | string>)[field] = value;
    states.set(trimmed, fields);
  };
  const markKeyUnknown = (key: string): void => {
    states.set(key.trim(), { enabled: "unknown", trustedHash: "unknown" });
  };

  const onHeader = (path: string[], isArray: boolean): void => {
    inFeaturesHeader = !isArray && path.length === 1 && path[0] === "features";
    if (inFeaturesHeader) featuresHeaderCount++;
    if (path[0] === "features" && (isArray || startsWithPath(path, ["features", "hooks"]) || startsWithPath(path, ["features", "codex_hooks"]))) {
      featureUnknown = true;
    }
    if (isArray && path[0] === "hooks" && (path.length < 2 || path[1] === "state")) statesUnknown = true;
  };

  const onAssignment = (keys: string[], value: TomlValue): void => {
    const full = [...table, ...keys];
    if (full[0] === "features") {
      if (table.length === 0) featuresInlineOrDotted = true;
      if (full.length === 1) {
        featureUnknown = true;
      } else if (full[1] === "hooks" || full[1] === "codex_hooks") {
        const canonical = full[1] === "hooks";
        if (full.length !== 2 || value.kind !== "bool") featureUnknown = true;
        else if (canonical) featureHooks = value.value;
        else featureAlias = value.value;
      }
    }
    if (full[0] === "hooks") {
      if (full.length === 1 || (full[1] === "state" && full.length === 2)) statesUnknown = true;
      else if (full[1] === "state") {
        const key = full[2];
        if (full.length === 3 || full.length > 4) markKeyUnknown(key);
        else if (full[3] === "enabled") {
          if (value.kind === "bool") setStateField(key, "enabled", value.value);
          else markKeyUnknown(key);
        } else if (full[3] === "trusted_hash") {
          if (value.kind === "string") setStateField(key, "trustedHash", value.value);
          else markKeyUnknown(key);
        }
      }
    }
  };

  if (src.charCodeAt(0) === 0xfeff) pos = 1;
  for (;;) {
    skipTrivia();
    if (pos >= n) break;
    if (src[pos] === "[") {
      const isArray = src[pos + 1] === "[";
      pos += isArray ? 2 : 1;
      const path = parseKeyPath();
      skipSpaces();
      if (src[pos] !== "]") fail();
      pos++;
      if (isArray) {
        if (src[pos] !== "]") fail();
        pos++;
      }
      endOfLine();
      table = path;
      current = declareHeader(path, isArray);
      onHeader(path, isArray);
      if (inFeaturesHeader && featuresInsertOffset === undefined) featuresInsertOffset = pos;
      continue;
    }
    const keys = parseKeyPath();
    skipSpaces();
    if (src[pos] !== "=") fail();
    pos++;
    skipSpaces();
    const value = parseValue();
    endOfLine();
    assign(current, keys, value);
    onAssignment(keys, value);
    if (inFeaturesHeader && featuresHeaderCount === 1) featuresInsertOffset = pos;
  }

  return {
    valid: true,
    featureHooks,
    featureAlias,
    featureUnknown,
    states,
    statesUnknown,
    featuresHeaderCount,
    featuresInlineOrDotted,
    featuresInsertOffset,
  };
}

const INVALID_SCAN: CodexTomlScan = Object.freeze({
  valid: false,
  featureUnknown: true,
  states: new Map<string, CodexHookStateFields>(),
  statesUnknown: true,
  featuresHeaderCount: 0,
  featuresInlineOrDotted: false,
});

/** Tokenise config.toml. Any unsupported construct yields an invalid (all-unknown) scan. */
export function scanCodexConfigToml(content: string): CodexTomlScan {
  try {
    return parseTomlDocument(content);
  } catch {
    // Syntax failures and pathological nesting are both "cannot classify".
    return INVALID_SCAN;
  }
}

/** Classify the effective hooks feature flag; canonical "hooks" wins over the codex_hooks alias. */
export function classifyCodexHooksFeatureScan(scan: CodexTomlScan): CodexHooksFeatureClass {
  if (!scan.valid || scan.featureUnknown) return "unrecognized";
  const effective = scan.featureHooks ?? scan.featureAlias;
  if (effective === undefined) return "absent";
  return effective ? "explicit-true" : "explicit-false";
}

export function classifyCodexHooksFeature(content: string): CodexHooksFeatureClass {
  return classifyCodexHooksFeatureScan(scanCodexConfigToml(content));
}

/**
 * Add hooks = true only when the feature is absent and a safe location exists.
 * Existing values, spellings and unrecognised forms are returned byte-identical.
 */
export function addCodexHooksFeature(content: string): { readonly content: string; readonly added: boolean } {
  // Only TOML blank space counts as empty: other whitespace is an invalid document, left alone.
  if (/^(?:[ \t]|\r?\n)*$/.test(content)) return { content: "[features]\nhooks = true\n", added: true };
  const scan = scanCodexConfigToml(content);
  if (classifyCodexHooksFeatureScan(scan) !== "absent" || scan.featuresInlineOrDotted) {
    return { content, added: false };
  }
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  if (scan.featuresHeaderCount === 1) {
    const offset = scan.featuresInsertOffset!;
    const head = content.slice(0, offset);
    return {
      content: head + (head.endsWith("\n") ? "" : eol) + "hooks = true" + eol + content.slice(offset),
      added: true,
    };
  }
  const base = content.endsWith("\n") ? content : content + eol;
  return { content: base + eol + "[features]" + eol + "hooks = true" + eol, added: true };
}
