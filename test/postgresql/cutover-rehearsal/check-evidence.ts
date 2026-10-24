import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * The supported subset of JSON Schema that evidence-schema.json uses: type, enum, const, pattern, minLength,
 * maxLength, minimum, maximum, minItems, maxItems, maxProperties, required, properties, additionalProperties, items
 * and local $ref. Anything else in a schema is rejected so the contract cannot drift from this checker.
 */
type Schema = { readonly [keyword: string]: unknown };
const SUPPORTED = new Set([
  "$schema", "$id", "$comment", "title", "$defs", "type", "enum", "const", "pattern", "minLength", "maxLength", "minimum", "maximum",
  "minItems", "maxItems", "maxProperties", "required", "properties", "additionalProperties", "items", "$ref",
]);

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function resolve(root: Schema, ref: string): Schema {
  if (!ref.startsWith("#/")) throw new Error("unsupported $ref " + ref);
  let node: unknown = root;
  for (const part of ref.slice(2).split("/")) node = (node as Record<string, unknown>)[part];
  if (node === undefined || node === null || typeof node !== "object") throw new Error("unresolvable $ref " + ref);
  return node as Schema;
}

function check(root: Schema, schema: Schema, value: unknown, at: string, errors: string[]): void {
  for (const keyword of Object.keys(schema)) if (!SUPPORTED.has(keyword)) throw new Error("unsupported schema keyword " + keyword + " at " + at);
  if (typeof schema.$ref === "string") { check(root, resolve(root, schema.$ref), value, at, errors); return; }
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    const actual = typeOf(value);
    if (!allowed.includes(actual) && !(actual === "integer" && allowed.includes("number"))) { errors.push(at + ": type " + actual + " not in " + allowed.join("|")); return; }
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(at + ": not the constant " + JSON.stringify(schema.const));
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) errors.push(at + ": not in the enumeration");
  if (typeof value === "string") {
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errors.push(at + ": longer than " + String(schema.maxLength));
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(at + ": shorter than " + String(schema.minLength));
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) errors.push(at + ": does not match " + schema.pattern);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(at + ": below " + String(schema.minimum));
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(at + ": above " + String(schema.maximum));
  }
  if (Array.isArray(value)) {
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(at + ": more than " + String(schema.maxItems) + " items");
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(at + ": fewer than " + String(schema.minItems) + " items");
    if (schema.items !== undefined) value.forEach((entry, index) => check(root, schema.items as Schema, entry, at + "[" + String(index) + "]", errors));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const name of (schema.required ?? []) as string[]) if (!(name in record)) errors.push(at + ": missing " + name);
    if (typeof schema.maxProperties === "number" && Object.keys(record).length > schema.maxProperties) errors.push(at + ": more than " + String(schema.maxProperties) + " properties");
    for (const [name, entry] of Object.entries(record)) {
      if (properties[name] !== undefined) check(root, properties[name], entry, at + "." + name, errors);
      else if (schema.additionalProperties === false) errors.push(at + ": unexpected key " + name);
      else if (typeof schema.additionalProperties === "object" && schema.additionalProperties !== null) check(root, schema.additionalProperties as Schema, entry, at + "." + name, errors);
    }
  }
}

/** Validate a value against a schema root (default: the whole document, or a local reference such as #/$defs/rehearsal); returns the errors. */
export function validateEvidence(schema: Schema, value: unknown, root = "#"): string[] {
  const errors: string[] = [];
  check(schema, root === "#" ? schema : resolve(schema, root), value, "$", errors);
  return errors;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [schemaPath, documentPath, root] = process.argv.slice(2);
  if (schemaPath === undefined || documentPath === undefined) {
    process.stderr.write("usage: check-evidence.ts <schema.json> <document.json> [#/$defs/<root>]\n");
    process.exit(2);
  }
  const errors = validateEvidence(JSON.parse(readFileSync(schemaPath, "utf8")) as Schema, JSON.parse(readFileSync(documentPath, "utf8")), root);
  process.stdout.write(errors.length === 0 ? "evidence conforms to the supported schema subset\n" : errors.slice(0, 50).join("\n") + "\n");
  process.exit(errors.length === 0 ? 0 : 1);
}

