import { describe, expect, it } from "vitest";
import {
  codexLcmHooks,
  hasCodexHooksContent,
  mergeCodexHooksContent,
  parseCodexHooksJson,
  planCodexHooksInstall,
  removeCodexHooksContent,
} from "../../src/connectors/codex-hooks.js";

const STOP_MINE = '{"type":"command","command":"echo mine"}';
const LCM_STOP = '{"type":"command","command":"lcm session-snapshot --client codex"}';

describe("parseCodexHooksJson", () => {
  it("accepts exactly the text JSON.parse accepts and returns its value", () => {
    const text = '{"a":"x\\"{[,:]}\\\\","b":[1,[2,{"c":null}],true,false,"\\u00e9"],"d":{"e":-1.5e+3,"f":{}},"g":[]}';
    const parsed = parseCodexHooksJson(" \n\t\r" + text + "\r\n ")!;
    expect(parsed.value).toEqual(JSON.parse(text));
    expect(parsed.duplicates).toEqual([]);
    expect(parseCodexHooksJson("null")!.value).toBeNull();
    expect(parseCodexHooksJson('"s"')!.value).toBe("s");
    for (const bad of [
      "", "   ", "not json", "{,}", '{"a":1,}', '{"a":1} x', '{"a":1}\\n', "\uFEFF{}", "\uFEFF", "\f{}", "[1,]", "{'a':1}", "01", '{"a"}',
    ]) {
      expect(parseCodexHooksJson(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("records every repeated member name with its structural path", () => {
    const parsed = parseCodexHooksJson('{"a":{"b":[{"c":1,"c":2},{"c":3}]},"a":3,"d":{"d":1},"\\u0064":4}')!;
    expect(parsed.duplicates).toEqual([
      { path: ["a", "b", 0], name: "c" },
      { path: [], name: "a" },
      { path: [], name: "d" },
    ]);
    expect(parseCodexHooksJson('[{"a":1},{"a":2},{"a":{"a":1}}]')!.duplicates).toEqual([]);
    expect(parseCodexHooksJson('{"a":1,"\\u0061":2}')!.duplicates).toEqual([{ path: [], name: "a" }]);
    expect(parseCodexHooksJson('{"a":1,"b":2,"a":3,"a":4}')!.duplicates).toEqual([
      { path: [], name: "a" },
      { path: [], name: "a" },
    ]);
  });

  const handlerDocument = (handler: string) => '{"hooks":{"Stop":[{"hooks":[' + handler + "]}]}}";
  const handlerPath = (field: string | number): Array<string | number> => ["hooks", "Stop", 0, "hooks", 0, field];

  it("tells integer tokens from other number spellings at the handler count fields", () => {
    for (const field of ["timeout", "additionalContextLimit"]) {
      for (const token of ["1.5", "30.0", "3e1", "1E1", "1e+2", "-0", "-0.0", "-5"]) {
        const parsed = parseCodexHooksJson(handlerDocument('{"' + field + '":' + token + "}"))!;
        expect(parsed.nonIntegerNumberAt(handlerPath(field)), field + " " + token).toBe(true);
      }
      for (const token of ["0", "30", "2500"]) {
        const parsed = parseCodexHooksJson(handlerDocument('{"' + field + '":' + token + "}"))!;
        expect(parsed.nonIntegerNumberAt(handlerPath(field)), field + " " + token).toBe(false);
      }
    }
  });

  it("marks a repeated count field when any occurrence is not an unsigned integer", () => {
    const spelled = (first: string, second: string) =>
      parseCodexHooksJson(handlerDocument('{"timeout":' + first + ',"timeout":' + second + "}"))!.nonIntegerNumberAt(handlerPath("timeout"));
    expect(spelled("1.5", "2")).toBe(true);
    expect(spelled("2", "1.5")).toBe(true);
    expect(spelled("2", "3")).toBe(false);
  });

  it("answers per event, group, handler and field", () => {
    const parsed = parseCodexHooksJson(
      '{"hooks":{"Stop":[{"hooks":[{"timeout":1.5},{"timeout":2,"additionalContextLimit":0.5}]},'
        + '{"hooks":[{"timeout":3},{"timeout":2.5}]}],"SessionStart":[{"hooks":[{"timeout":4.5}]}]}}',
    )!;
    const recorded = [
      ["Stop", 0, 0, "timeout"],
      ["Stop", 0, 1, "additionalContextLimit"],
      ["Stop", 1, 1, "timeout"],
      ["SessionStart", 0, 0, "timeout"],
    ] as const;
    for (const [event, group, handler, field] of recorded) {
      expect(parsed.nonIntegerNumberAt(["hooks", event, group, "hooks", handler, field]), field).toBe(true);
    }
    const unrecorded: Array<Array<string | number>> = [
      ["hooks", "Stop", 0, "hooks", 0, "additionalContextLimit"],
      ["hooks", "Stop", 0, "hooks", 1, "timeout"],
      ["hooks", "Stop", 1, "hooks", 0, "timeout"],
      ["hooks", "Stop", 2, "hooks", 0, "timeout"],
      ["hooks", "Stop", 0, "hooks", 2, "timeout"],
      ["hooks", "SessionStart", 0, "hooks", 1, "timeout"],
      ["hooks", "PreToolUse", 0, "hooks", 0, "timeout"],
      ["hooks", 5, 0, "hooks", 0, "timeout"],
      ["hooks", "Stop", "0", "hooks", 0, "timeout"],
      ["hooks", "Stop", 0, "hooks", "0", "timeout"],
      ["hooks", "Stop", 0, "hooks", 0, 0],
      ["hooks", "Stop", 0, "hooks", 0, "statusMessage"],
      ["hooks", "Stop", 0, "hooks", 0],
      ["hooks", "Stop", 0, "hooks"],
      ["hooks", "Stop", 0, "hooks", 0, "timeout", "x"],
      [],
      ["x", "Stop", 0, "hooks", 0, "timeout"],
      ["hooks", "Stop", 0, "x", 0, "timeout"],
    ];
    for (const path of unrecorded) expect(parsed.nonIntegerNumberAt(path), JSON.stringify(path)).toBe(false);
  });

  it("tracks nothing but the handler count fields", () => {
    const parsed = parseCodexHooksJson(
      '{"t":1.5,"hooks":{"Stop":[{"matcher":2.5,"hooks":[{"timeout":1.5,"statusMessage":3.5,"input":{"x":2.5,"y":[3.5]},"z":[4.5]}]}]}}',
    )!;
    expect(parsed.nonIntegerNumberAt(handlerPath("timeout"))).toBe(true);
    for (const path of [
      ["t"],
      ["hooks", "Stop", 0, "matcher"],
      handlerPath("statusMessage"),
      [...handlerPath("input"), "x"],
      [...handlerPath("input"), "y", 0],
      [...handlerPath("z"), 0],
    ]) {
      expect(parsed.nonIntegerNumberAt(path), JSON.stringify(path)).toBe(false);
    }
  });

  it("records a count field only inside the object, array, object, array, object nesting under root hooks", () => {
    const impostors: Array<[string, string]> = [
      ["an array root", '[{"Stop":[{"hooks":[{"timeout":1.5}]}]}]'],
      ["an array where the hooks object belongs", '{"hooks":[[{"hooks":[{"timeout":1.5}]}]]}'],
      ["an object where the groups array belongs", '{"hooks":{"Stop":{"x":{"hooks":[{"timeout":1.5}]}}}}'],
      ["an array where the group object belongs", '{"hooks":{"Stop":[[[{"timeout":1.5}]]]}}'],
      ["an object where the handlers array belongs", '{"hooks":{"Stop":[{"hooks":{"x":{"timeout":1.5}}}]}}'],
      ["an array where the handler object belongs", '{"hooks":{"Stop":[{"hooks":[[1.5]]}]}}'],
      ["a root member other than hooks", '{"x":{"Stop":[{"hooks":[{"timeout":1.5}]}]}}'],
      ["a group member other than hooks", '{"hooks":{"Stop":[{"matcher":[{"timeout":1.5}]}]}}'],
      ["a handler member that is not a count field", '{"hooks":{"Stop":[{"hooks":[{"statusMessage":1.5}]}]}}'],
      ["a number in place of a handler", '{"hooks":{"Stop":[{"hooks":[1.5]}]}}'],
      ["a number below a count field", '{"hooks":{"Stop":[{"hooks":[{"timeout":[1.5]}]}]}}'],
    ];
    const paths: Array<Array<string | number>> = [
      handlerPath("timeout"),
      handlerPath(0),
      handlerPath("statusMessage"),
      [0, "Stop", 0, "hooks", 0, "timeout"],
      ["hooks", 0, 0, "hooks", 0, 0],
      ["x", "Stop", 0, "hooks", 0, "timeout"],
      ["hooks", "Stop", 0, "matcher", 0, "timeout"],
      ["hooks", "Stop", 0, "hooks", "x", "timeout"],
      ["hooks", "x", "Stop", 0, "hooks", 0, "timeout"],
    ];
    for (const [name, content] of impostors) {
      const parsed = parseCodexHooksJson(content)!;
      for (const path of paths) expect(parsed.nonIntegerNumberAt(path), name + " " + JSON.stringify(path)).toBe(false);
    }
  });

  it("records nothing for floats under a long ignored member name", () => {
    const key = "k".repeat(8192);
    const floats = Array.from({ length: 128 }, () => "1.5").join(",");
    const documents: Array<[string, string, Array<string | number>]> = [
      ["the top level", '{"hooks":{},"x":{"' + key + '":[' + floats + "]}}", ["x", key]],
      ["a group member", '{"hooks":{"Stop":[{"' + key + '":[' + floats + '],"hooks":[{"timeout":1.5}]}]}}', ["hooks", "Stop", 0, key]],
      ["a handler member", '{"hooks":{"Stop":[{"hooks":[{"' + key + '":[' + floats + '],"timeout":1.5}]}]}}', [...handlerPath(key)]],
      [
        "a handler input",
        '{"hooks":{"Stop":[{"hooks":[{"input":{"' + key + '":[' + floats + '],"x":1.5},"timeout":1.5}]}]}}',
        [...handlerPath("input"), key],
      ],
    ];
    for (const [name, content, base] of documents) {
      const parsed = parseCodexHooksJson(content)!;
      for (let index = 0; index < 128; index += 1) {
        expect(parsed.nonIntegerNumberAt([...base, index]), name + " " + index).toBe(false);
      }
      expect(parsed.nonIntegerNumberAt([...base.slice(0, -1), "x"]), name).toBe(false);
      expect(parsed.nonIntegerNumberAt(handlerPath("timeout")), name).toBe(name === "the top level" ? false : true);
    }
  });

  it("answers for an event named by a long key", () => {
    const key = "k".repeat(8192);
    const parsed = parseCodexHooksJson('{"hooks":{"' + key + '":[{"hooks":[{"timeout":1.5},{"timeout":2}]}]}}')!;
    expect(parsed.nonIntegerNumberAt(["hooks", key, 0, "hooks", 0, "timeout"])).toBe(true);
    expect(parsed.nonIntegerNumberAt(["hooks", key, 0, "hooks", 1, "timeout"])).toBe(false);
  });

  it("walks deep nesting without recursion", () => {
    const depth = 20000;
    const parsed = parseCodexHooksJson('{"a":' + "[".repeat(depth) + "]".repeat(depth) + ',"a":1}')!;
    expect(parsed.duplicates).toEqual([{ path: [], name: "a" }]);
  });

  it("records only the first repeated member below the typed object depth", () => {
    const deepPath = ["deep", "b", "c", "d", "e", "f"];
    const parsed = parseCodexHooksJson(
      '{"s":1,"s":2,"deep":{"b":{"c":{"d":{"e":{"f":{"k":1,"k":2,"k":3,"j":1,"j":2}}}}}},"s":3,'
        + '"hooks":{"Stop":[{"hooks":[{"t":1,"t":2,"t":3}]}]}}',
    )!;
    expect(parsed.duplicates).toEqual([
      { path: [], name: "s" },
      { path: deepPath, name: "k" },
      { path: [], name: "s" },
      { path: ["hooks", "Stop", 0, "hooks", 0], name: "t" },
      { path: ["hooks", "Stop", 0, "hooks", 0], name: "t" },
    ]);
  });

  it("tracks non-integer numbers only down to the handler field depth", () => {
    const parsed = parseCodexHooksJson('{"hooks":{"Stop":[{"hooks":[{"timeout":1.5,"input":{"x":2.5,"y":[3.5]}}]}]}}')!;
    const base = ["hooks", "Stop", 0, "hooks", 0];
    expect(parsed.nonIntegerNumberAt([...base, "timeout"])).toBe(true);
    expect(parsed.nonIntegerNumberAt([...base, "input", "x"])).toBe(false);
    expect(parsed.nonIntegerNumberAt([...base, "input", "y", 0])).toBe(false);
  });
});

describe("hooks.json install refusal", () => {
  const trailingComma = '{"hooks": {"Stop": [{"hooks": [' + STOP_MINE + ']}],}}';
  // Valid JSON followed by a literal backslash and n, as in #1606.
  const trailingLiteral = '{"hooks":{"Stop":[{"hooks":[' + STOP_MINE + ']}]}}' + "\\n";
  const refusals: Array<[string, string, string]> = [
    ["a trailing comma", trailingComma, "is not valid JSON"],
    ["trailing literal backslash-n text", trailingLiteral, "is not valid JSON"],
    ["plain text", "not json", "is not valid JSON"],
    ["a byte order mark", "\uFEFF" + '{"hooks":{}}', "is not valid JSON"],
    ["a byte order mark alone", "\uFEFF", "is not valid JSON"],
    ["a form feed", "\f", "is not valid JSON"],
    ["a repeated root hooks key", '{"hooks":{"Stop":[{"hooks":[' + STOP_MINE + ']}]},"hooks":{}}', 'repeats the key "hooks"'],
    ["a repeated event key", '{"hooks":{"Stop":[],"Stop":[{"hooks":[' + STOP_MINE + ']}]}}', 'repeats the key "Stop"'],
    ["an escaped repeated key", '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo a","\\u0063ommand":"echo b"}]}]}}', 'repeats the key "command"'],
    ["a repeated key inside an mcp_tool input", '{"hooks":{"Stop":[{"hooks":[{"type":"mcp_tool","server":"s","tool":"t","input":{"a":1,"a":2}}]}]}}', 'repeats the key "a"'],
  ];

  it.each(refusals)("refuses %s and leaves the bytes unchanged", (_name, content, reason) => {
    const plan = planCodexHooksInstall(content, "model = 'x'\n");
    expect(plan.hooksContent).toBe(content);
    expect(plan.configContent).toBeUndefined();
    expect(plan.refusal).toContain(reason);
    expect(plan.refusal).toContain("left it unchanged");
    expect(plan.refusal).toContain("fix the file or move it aside");
    expect(plan.refusal).toContain("rerun lcm connectors install codex");
    expect(() => mergeCodexHooksContent(content)).toThrow(reason);
  });

  it("starts from an empty file only for empty or JSON-whitespace content", () => {
    for (const blank of ["", " \n\t\r\n"]) {
      const plan = planCodexHooksInstall(blank, "");
      expect(plan.refusal).toBeUndefined();
      expect(JSON.parse(plan.hooksContent).hooks).toEqual(codexLcmHooks());
    }
  });

  it("keeps normalizing valid JSON that is not a hooks object", () => {
    for (const content of ["null", "[]", '{"hooks": []}', "5"]) {
      expect(JSON.parse(mergeCodexHooksContent(content)).hooks, content).toEqual(codexLcmHooks());
    }
  });
});

describe("hooks.json uninstall and detection over repeated keys", () => {
  const duplicate = '{"description":"a","description":"b","hooks":{"Stop":[{"hooks":[' + STOP_MINE + "," + LCM_STOP + "]}]}}";
  const valid = '{"description":"a","hooks":{"Stop":[{"hooks":[' + STOP_MINE + "," + LCM_STOP + "]}]}}";

  it("leaves a file with a repeated key unchanged and does not see its LCM hook", () => {
    expect(removeCodexHooksContent(duplicate)).toEqual({ state: "unchanged", content: duplicate });
    expect(hasCodexHooksContent(duplicate)).toBe(false);
  });

  it("leaves malformed JSON unchanged", () => {
    expect(removeCodexHooksContent("not json")).toEqual({ state: "unchanged", content: "not json" });
    expect(hasCodexHooksContent("not json")).toBe(false);
  });

  it("still removes and detects LCM hooks in a valid file", () => {
    expect(hasCodexHooksContent(valid)).toBe(true);
    const removed = removeCodexHooksContent(valid);
    expect(removed.state).toBe("rewrite");
    expect(JSON.parse(removed.content)).toEqual({ description: "a", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } });
  });
});
