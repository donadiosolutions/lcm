import { describe, it, expect } from "vitest";
import { loadTemplate, interpolate, renderTemplate } from "../../src/prompts/loader.js";

describe("interpolate", () => {
  it("replaces {{var}} placeholders", () => {
    const result = interpolate("Hello {{name}}, you have {{count}} items", {
      name: "Alice",
      count: "3",
    });
    expect(result).toBe("Hello Alice, you have 3 items");
  });

  it("leaves unmatched placeholders as empty string", () => {
    const result = interpolate("Hello {{name}}", {});
    expect(result).toBe("Hello ");
  });

  it("handles multiple occurrences of same variable", () => {
    const result = interpolate("{{x}} and {{x}}", { x: "yes" });
    expect(result).toBe("yes and yes");
  });

  it("uses an empty string for explicitly undefined values", () => {
    const result = interpolate("{{value}}", { value: undefined as unknown as string });
    expect(result).toBe("");
  });
});

describe("loadTemplate", () => {
  it("loads and parses a YAML template file", () => {
    const tpl = loadTemplate("system");
    expect(tpl.name).toBe("system");
    expect(tpl.template).toBeTruthy();
    expect(typeof tpl.template).toBe("string");
  });

  it("throws on unknown template name", () => {
    expect(() => loadTemplate("nonexistent-template")).toThrow();
  });

  it.each(["../system", "nested/system", "system\0yaml"])(
    "rejects unsafe template name %j",
    (name) => {
      expect(() => loadTemplate(name)).toThrow(`Invalid template name: ${name}`);
    },
  );

  it("returns cached templates and renders them", () => {
    const first = loadTemplate("system");
    expect(loadTemplate("system")).toBe(first);
    expect(renderTemplate("system", {})).toBe(first.template.replace(/\{\{(\w+)\}\}/g, ""));
  });
});
