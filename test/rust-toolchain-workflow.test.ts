import { readFileSync } from "node:fs";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

interface WorkflowStep {
  name?: string;
  if?: string;
  uses?: string;
  with?: Record<string, string>;
}

interface CodeqlWorkflow {
  jobs: {
    analyze: {
      strategy: { matrix: { language: string[] } };
      steps: WorkflowStep[];
    };
  };
}

const setupAction = readFileSync(
  new URL("../.github/actions/setup-rust-toolchain/action.yml", import.meta.url),
  "utf8",
);
const installer = readFileSync(
  new URL("../.github/scripts/install-verified-rust-toolchain.py", import.meta.url),
  "utf8",
);
const codeqlSource = readFileSync(new URL("../.github/workflows/codeql.yml", import.meta.url), "utf8");
const codeql = loadYaml(codeqlSource) as CodeqlWorkflow;

describe("verified Rust CI toolchain", () => {
  it("pins every required official archive and verifies it before unpacking", () => {
    expect(installer).toContain("https://static.rust-lang.org/dist/2026-01-22/rustc-1.93.0-x86_64-unknown-linux-gnu.tar.xz");
    expect(installer).toContain("00c6e6740ea6a795e33568cd7514855d58408a1180cd820284a7bbf7c46af715");
    expect(installer).toContain("https://static.rust-lang.org/dist/2026-01-22/cargo-1.93.0-x86_64-unknown-linux-gnu.tar.xz");
    expect(installer).toContain("c23de3ae709ff33eed5e4ae59d1f9bcd75fa4dbaa9fb92f7b06bfb534b8db880");
    expect(installer).toContain("https://static.rust-lang.org/dist/2026-01-22/rust-std-1.93.0-x86_64-unknown-linux-gnu.tar.xz");
    expect(installer).toContain("a849a418d0f27e69573e41763c395e924a0b98c16fcdc55599c1c79c27c1c777");
    expect(installer).toContain("https://static.rust-lang.org/dist/2026-01-22/rust-std-1.93.0-x86_64-unknown-linux-musl.tar.xz");
    expect(installer).toContain("874658d2ced1ed2b9bf66c148b78a2e10cad475d0a4db32e68a08900905b89b8");
    expect(installer).toContain("254b59607d4417e9dffbc307138ae5c86280fe4c");
    expect(installer).toContain('["sha256sum", "--check", "--strict"');
    expect(installer).toContain('f"--prefix={prefix}"');
    const verificationLoop = installer.indexOf(
      "for component, archive in archives:\n            verify_archive(component, archive, checksums_dir)",
    );
    const installLoop = installer.indexOf(
      "for component, archive in archives:\n            component_dir = safe_extract(archive, temporary_path / component.name)",
    );
    expect(verificationLoop).toBeGreaterThanOrEqual(0);
    expect(installLoop).toBeGreaterThan(verificationLoop);
    expect(installer).not.toMatch(/\b(?:curl|wget)\b/u);
  });

  it("uses the local verified setup before Rust CodeQL initialization", () => {
    expect(setupAction).toContain("install-verified-rust-toolchain.py");
    expect(setupAction).toContain('"$RUNNER_TEMP/lcm-rust-1.93.0/bin" >> "$GITHUB_PATH"');
    expect(codeql.jobs.analyze.strategy.matrix.language).toEqual([
      "actions",
      "javascript-typescript",
      "rust",
    ]);

    const setupIndex = codeql.jobs.analyze.steps.findIndex(
      (step) => step.name === "Set up verified Rust toolchain",
    );
    const initializeIndex = codeql.jobs.analyze.steps.findIndex(
      (step) => step.name === "Initialize CodeQL",
    );
    expect(codeql.jobs.analyze.steps[setupIndex]).toEqual({
      name: "Set up verified Rust toolchain",
      if: "${{ matrix.language == 'rust' }}",
      uses: "./.github/actions/setup-rust-toolchain",
    });
    expect(setupIndex).toBeGreaterThanOrEqual(0);
    expect(initializeIndex).toBeGreaterThan(setupIndex);
    expect(codeqlSource).toContain("github/codeql-action/init@e4fba868fa4b1b91e1fdab776edc8cfbe6e9fb81");
    expect(codeqlSource).toContain("github/codeql-action/analyze@e4fba868fa4b1b91e1fdab776edc8cfbe6e9fb81");
    expect(codeqlSource).toContain("build-mode: none");
  });
});
