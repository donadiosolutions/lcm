export type RuntimeHomeOsModule = {
  homedir: () => string;
};

type RuntimeHomedirState = {
  environment: NodeJS.ProcessEnv;
  nativeHomedir: () => string;
  wrapper: () => string;
};

const runtimeHomedirStateKey = Symbol.for("lcm.vitest.runtimeHomedir");

export function resolveTestRuntimeHome(
  environment: Readonly<NodeJS.ProcessEnv>,
  nativeHomedir: () => string,
): string {
  if (environment.HOME !== undefined && environment.HOME !== "") {
    return environment.HOME;
  }
  if (environment.USERPROFILE !== undefined && environment.USERPROFILE !== "") {
    return environment.USERPROFILE;
  }
  return nativeHomedir();
}

export function installTestRuntimeHomedir(
  osModule: RuntimeHomeOsModule,
  syncBuiltinExports: () => void,
  environment: NodeJS.ProcessEnv = process.env,
): () => string {
  const sharedModule = osModule as RuntimeHomeOsModule & {
    [runtimeHomedirStateKey]?: RuntimeHomedirState;
  };
  let state = sharedModule[runtimeHomedirStateKey];
  if (state === undefined) {
    const nativeHomedir = sharedModule.homedir;
    state = {
      environment,
      nativeHomedir,
      wrapper: () => resolveTestRuntimeHome(environment, nativeHomedir),
    };
    Object.defineProperty(sharedModule, runtimeHomedirStateKey, {
      configurable: false,
      enumerable: false,
      value: state,
      writable: false,
    });
  }

  if (sharedModule.homedir !== state.wrapper) {
    sharedModule.homedir = state.wrapper;
    syncBuiltinExports();
  }
  return state.wrapper;
}
