export const LEGACY_PRODUCT_WORD = "lossless";
export const LEGACY_AGENT_WORD = "claude";

export function legacyLcmSlug(): string {
  return [LEGACY_PRODUCT_WORD, LEGACY_AGENT_WORD].join("-");
}

export function legacyLcmHomeDirname(): string {
  return `.${legacyLcmSlug()}`;
}

export function legacyLcmCommand(command: string): string {
  return command.replace(/^lcm\b/, legacyLcmSlug());
}

export function legacyLcmMcpServerName(): string {
  return legacyLcmSlug();
}

export function legacyLaunchdPlistName(): string {
  return ["com", LEGACY_PRODUCT_WORD, LEGACY_AGENT_WORD, "daemon", "plist"].join(".");
}

export function legacySystemdServiceName(): string {
  return `${legacyLcmSlug()}.service`;
}
