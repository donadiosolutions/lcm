import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("node:child_process", () => ({ fork: harness.fork }));
import { readDiagnosticSqlite } from "../../src/db/diagnostic-sqlite.js";

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
