import { describe, expect, it, vi } from "vitest";
import { NinjaRenderer } from "../src/cli/pipeline-runner.js";
import { makeProgressState } from "../src/cli/progress-state.js";
import { printImportSummary } from "../src/import-summary.js";

describe("operational progress output", () => {
  it("writes progress and summary exclusively to the selected output", () => {
    const write = vi.fn(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const state = makeProgressState({phases:[{name:"Import",status:"done"}],total:1});
    state.completed=1;
    const renderer = new NinjaRenderer({state,renderOpts:{isTTY:true,width:80,color:false,verbose:false},output:{write,columns:80},handleSignals:false});
    try {
      renderer.start();
      renderer.stop();
      renderer.printSummary();
      expect(write.mock.calls.map(args => args[0]).join("")).toContain("Import");
      expect(stdout).not.toHaveBeenCalled();
    } finally {renderer.stop();stdout.mockRestore();}
  });
  it("routes all native import summary rows to the supplied logger", () => {
    const lines: unknown[]=[];
    const stdout = vi.spyOn(console,"log").mockImplementation(() => undefined);
    try {
      printImportSummary({imported:1,skippedEmpty:0,failed:0,totalMessages:2,totalTokens:10,tokensAfter:0,reconciled:1}, {log:value => {lines.push(value);}});
      expect(lines.join("\n")).toContain("1 historical Codex sessions reconciled");
      expect(stdout).not.toHaveBeenCalled();
    } finally {stdout.mockRestore();}
  });
});
