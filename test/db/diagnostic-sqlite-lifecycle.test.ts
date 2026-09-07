import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("node:child_process", () => ({ fork: harness.fork }));
import { readDiagnosticSqlite, withDiagnosticSqliteSession } from "../../src/db/diagnostic-sqlite.js";

class DiagnosticChild extends EventEmitter {
  send = vi.fn((_request: unknown, callback: (error: Error | null) => void) => { callback(null); });
  kill = vi.fn((_signal: string) => true);
  unref = vi.fn();
}
let child: DiagnosticChild;
const request = {path:"/trusted/database.sqlite",expected:{device:1n,inode:2n},statements:[]};
beforeEach(() => {
  vi.useFakeTimers();
  child = new DiagnosticChild();
  harness.fork.mockReset().mockReturnValue(child as unknown as ChildProcess);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("diagnostic child ownership and lifecycle", () => {
  it("returns only child result rows and closes the owned process once despite late events", async () => {
    const reading = readDiagnosticSqlite(request);
    child.emit("message","ready");
    child.emit("message",{ok:true,rows:[{count:3}]});
    expect(await reading).toEqual([{count:3}]);
    child.emit("message",{ok:true,rows:[{count:999}]});
    child.emit("error",new Error("late private error"));
    child.emit("exit",0);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(child.unref).toHaveBeenCalledOnce();
    expect(child.listenerCount("message")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("remaps borrowed parent descriptors and avoids preload or ambient environment startup", async () => {
    const reading=readDiagnosticSqlite({...request,parents:[{path:"/trusted",fd:25,device:1n,inode:3n}]});
    const [sent] = child.send.mock.calls[0];
    expect(sent).toMatchObject({parents:[{path:"/trusted",fd:4,device:1n,inode:3n}]});
    expect(harness.fork.mock.calls[0][2]).toMatchObject({execArgv:[],env:{},stdio:["ignore","ignore","ignore","ipc",25],serialization:"advanced"});
    child.emit("message",{ok:true,rows:[]});
    await reading;
  });

  it.each(["EACCES","EPERM","ENOENT","ELOOP","DIAGNOSTIC_SQLITE_IDENTITY","DIAGNOSTIC_SQLITE_RESULT_TOO_LARGE","DIAGNOSTIC_SQLITE_QUERY","private-code"])("sanitizes the %s child refusal",async code=>{
    const reading=readDiagnosticSqlite(request);
    const rejection=expect(reading).rejects.toMatchObject({message:"SQLite diagnostic unavailable",code:code==="private-code"?"DIAGNOSTIC_SQLITE_WORKER":code});
    child.emit("message",{ok:false,code,message:"private path must disappear"});
    await rejection;
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  });

  it.each(["error","exit"])("closes after child %s without leaking a raw error",async event=>{
    const reading=readDiagnosticSqlite(request);
    const rejection=expect(reading).rejects.toMatchObject({message:"SQLite diagnostic unavailable",code:"DIAGNOSTIC_SQLITE_WORKER"});
    child.emit(event,new Error("private transport"));
    await rejection;
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("settles spawn failure without claiming a child was acquired",async()=>{
    harness.fork.mockImplementation(()=>{throw new Error("private launch path");});
    await expect(readDiagnosticSqlite(request)).rejects.toMatchObject({code:"DIAGNOSTIC_SQLITE_WORKER"});
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles IPC send failures and preserves that outcome when cleanup throws",async()=>{
    child.send.mockImplementation((_request,callback)=>{callback(new Error("private IPC path"));});
    child.kill.mockImplementation(()=>{throw new Error("private kill failure");});
    await expect(readDiagnosticSqlite(request)).rejects.toMatchObject({code:"DIAGNOSTIC_SQLITE_WORKER"});
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("handles a synchronous IPC exception after acquisition",async()=>{
    child.send.mockImplementation(()=>{throw new Error("private send path");});
    await expect(readDiagnosticSqlite(request)).rejects.toMatchObject({code:"DIAGNOSTIC_SQLITE_WORKER"});
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("cancels after acquisition, including a signal already aborted during IPC dispatch",async()=>{
    const controller=new AbortController();
    child.send.mockImplementation((_request,callback)=>{controller.abort();callback(null);});
    await expect(readDiagnosticSqlite({...request,signal:controller.signal})).rejects.toMatchObject({code:"DIAGNOSTIC_SQLITE_ABORTED"});
    expect(child.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not spawn for a pre-aborted signal",async()=>{
    const controller=new AbortController();controller.abort();
    await expect(readDiagnosticSqlite({...request,signal:controller.signal})).rejects.toMatchObject({code:"DIAGNOSTIC_SQLITE_ABORTED"});
    expect(harness.fork).not.toHaveBeenCalled();
  });

  it.each([0,-1,NaN,Infinity])("rejects an invalid deadline of %s before spawn",async timeoutMs=>{
    await expect(readDiagnosticSqlite({...request,timeoutMs})).rejects.toMatchObject({code:"DIAGNOSTIC_SQLITE_TIMEOUT"});
    expect(harness.fork).not.toHaveBeenCalled();
  });

  it("clamps the caller's deadline and returns without awaiting delayed exit",async()=>{
    const reading=readDiagnosticSqlite({...request,timeoutMs:99_999});
    const rejection=expect(reading).rejects.toMatchObject({code:"DIAGNOSTIC_SQLITE_TIMEOUT"});
    await vi.advanceTimersByTimeAsync(1999);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
  });
});


describe("snapshot-owned SQLite session", () => {
  const start = (operation: (signal: AbortSignal) => Promise<unknown>) => {
    const controller = new AbortController();
    return {controller, result: withDiagnosticSqliteSession(controller.signal, () => operation(controller.signal))};
  };
  it("serializes queued requests in one child and finalizes once", async () => {
    const {result} = start(async signal => {
      const first = readDiagnosticSqlite({...request,signal});
      const second = readDiagnosticSqlite({...request,signal});
      expect(child.send).toHaveBeenCalledTimes(1);
      child.emit("message", "ready");
      child.emit("message", {id:1,ok:true,rows:[1]});
      expect(child.send).toHaveBeenCalledTimes(2);
      child.emit("message", {id:2,ok:true,rows:[2]});
      return Promise.all([first,second]);
    });
    expect(await result).toEqual([[1],[2]]);
    expect(harness.fork).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    child.emit("error", new Error("late private failure"));
    child.emit("exit", 0);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("borrows the enclosing session for a nested sidecar scan", async () => {
    const {result} = start(signal => withDiagnosticSqliteSession(signal, async () => {
      const reading = readDiagnosticSqlite({...request,signal});
      child.emit("message", {id:1,ok:true,rows:[]});
      return reading;
    }));
    expect(await result).toEqual([]);
    expect(harness.fork).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledOnce();
  });
  it.each(["error", "exit", "send", "throw", "spawn", "kill"])("preserves sanitized session failure from %s", async kind => {
    if (kind === "spawn") harness.fork.mockImplementation(()=>{throw new Error("private spawn");});
    if (kind === "send") child.send.mockImplementation((_request,callback)=>callback(new Error("private IPC")));
    if (kind === "throw") child.send.mockImplementation(()=>{throw new Error("private IPC");});
    if (kind === "kill") child.kill.mockImplementation(()=>{throw new Error("private kill");});
    const {result} = start(signal => {
      const reading = readDiagnosticSqlite({...request,signal});
      if (["error","exit","kill"].includes(kind)) child.emit(kind === "kill" ? "error" : kind, new Error("private transport"));
      return reading;
    });
    await expect(result).rejects.toMatchObject({code:"DIAGNOSTIC_SQLITE_WORKER",message:"SQLite diagnostic unavailable"});
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["EACCES", "EPERM", "ENOENT", "ELOOP", "DIAGNOSTIC_SQLITE_IDENTITY", "DIAGNOSTIC_SQLITE_RESULT_TOO_LARGE", "DIAGNOSTIC_SQLITE_REQUEST_TOO_LARGE", "DIAGNOSTIC_SQLITE_QUERY", "private"])("sanitizes a session %s refusal", async code => {
    const {result} = start(signal => {
      const reading=readDiagnosticSqlite({...request,signal});
      child.emit("message", {id:1,ok:false,code});
      return reading;
    });
    await expect(result).rejects.toMatchObject({code:code === "private" ? "DIAGNOSTIC_SQLITE_WORKER" : code});
  });
  it.each(["active", "idle"])("rejects an unmatched reply while %s so it cannot satisfy another request", async state => {
    const {result} = start(async signal => {
      const reading=readDiagnosticSqlite({...request,signal});
      if (state === "idle") {
        child.emit("message", {id:1,ok:true,rows:[1]});
        await reading;
      }
      child.emit("message", {id:99,ok:true,rows:[99]});
      if (state === "active") return reading;
      return readDiagnosticSqlite({...request,signal});
    });
    await expect(result).rejects.toMatchObject({code:"DIAGNOSTIC_SQLITE_WORKER"});
  });
  it("aborts all queued reads and closes exactly once", async () => {
    const controller=new AbortController();
    const result=withDiagnosticSqliteSession(controller.signal, () => {
      const first=readDiagnosticSqlite({...request,signal:controller.signal});
      const second=readDiagnosticSqlite({...request,signal:controller.signal});
      controller.abort();
      return Promise.all([first,second]);
    });
    await expect(result).rejects.toMatchObject({code:"DIAGNOSTIC_SQLITE_ABORTED"});
    expect(child.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not spawn when the scope is already aborted", async () => {
    const controller=new AbortController();controller.abort();
    await expect(withDiagnosticSqliteSession(controller.signal, ()=>readDiagnosticSqlite({...request,signal:controller.signal}))).rejects.toMatchObject({code:"DIAGNOSTIC_SQLITE_ABORTED"});
    expect(harness.fork).not.toHaveBeenCalled();
  });
  it.each([20, 2000])("owns a total lifetime bound and shortened request deadline %i", async timeoutMs => {
    const {result}=start(signal=>readDiagnosticSqlite({...request,signal,timeoutMs}));
    const rejection=expect(result).rejects.toMatchObject({code:"DIAGNOSTIC_SQLITE_TIMEOUT"});
    await vi.advanceTimersByTimeAsync(timeoutMs);
    await rejection;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds queued requests without sending or retaining unbounded frames", async () => {
    const {result}=start(async signal=>{
      const readings=Array.from({length:34},()=>readDiagnosticSqlite({...request,signal}));
      const outcomes=Promise.allSettled(readings);
      child.emit("error",new Error("stop owned fixture"));
      return outcomes;
    });
    const outcomes=await result as PromiseSettledResult<unknown>[];
    expect(outcomes).toHaveLength(34);
    expect(outcomes.every(item=>item.status === "rejected")).toBe(true);
    expect(child.send).toHaveBeenCalledOnce();
  });
  it("refuses oversized requests before spawning", async () => {
    const {result}=start(signal=>readDiagnosticSqlite({...request,signal,statements:[{sql:"x".repeat(1024*1024),mode:"get"}]}));
    await expect(result).rejects.toMatchObject({code:"DIAGNOSTIC_SQLITE_REQUEST_TOO_LARGE"});
    expect(harness.fork).not.toHaveBeenCalled();
  });
  it("closes an unused scope without spawning", async () => {
    const {result}=start(async()=>42);
    expect(await result).toBe(42);
    expect(harness.fork).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
