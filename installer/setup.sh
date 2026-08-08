#!/usr/bin/env bash
set -euo pipefail

# lcm setup script
# Configures the LLM provider for compaction/summarization and installs hooks.

CONFIG_DIR="$HOME/.lcm"
CONFIG_FILE="$CONFIG_DIR/config.json"
LEGACY_CONFIG_DIR="$HOME/.lossless-claude"

# ── Dry-run support (used by installer/dry-run-deps.ts) ──

if [ "${XGH_DRY_RUN:-}" = "1" ]; then
  echo ""
  echo "  [dry-run] lcm setup would:"
  echo "    1. Prompt for LLM provider selection (auto / claude-process / codex-process / anthropic / openai / disabled)"
  echo "    2. Write ~/.lcm/config.json with the chosen llm block"
  echo "    3. Run: lcm install"
  echo "    4. Run: lcm doctor"
  echo ""
  exit 0
fi

# ── Preflight: require lcm ──

if ! command -v lcm &>/dev/null; then
  echo ""
  echo "  ERROR: lcm is not installed."
  echo ""
  echo "    Install it with:  npm install -g @donadiosolutions/lcm"
  echo ""
  exit 1
fi

# ── Provider Selection ──

PROVIDER="auto"
MODEL=""
API_KEY=""
BASE_URL=""

if [ ! -t 0 ]; then
  # Non-interactive / CI mode: skip prompts and fall through using defaults.
  true
else
  echo ""
  echo "  lcm setup"
  echo ""
  echo "  Which LLM provider should lcm use for compaction/summarization?"
  echo ""
  echo "    1) auto           — uses claude-process (or codex-process for Codex clients) [recommended]"
  echo "    2) claude-process — Claude Code CLI subprocess (no API key needed)"
  echo "    3) codex-process  — Codex CLI subprocess (no API key needed)"
  echo "    4) anthropic      — Anthropic API (requires ANTHROPIC_API_KEY env var)"
  echo "    5) openai         — OpenAI-compatible API (uses OPENAI_API_KEY when required by the server)"
  echo "    6) disabled       — no LLM, import-only mode (no compaction)"
  echo ""

  read -r -p "  Pick [1]: " PROVIDER_CHOICE
  PROVIDER_CHOICE="${PROVIDER_CHOICE:-1}"

  case "$PROVIDER_CHOICE" in
    1) PROVIDER="auto" ;;
    2) PROVIDER="claude-process" ;;
    3) PROVIDER="codex-process" ;;
    4) PROVIDER="anthropic" ;;
    5) PROVIDER="openai" ;;
    6) PROVIDER="disabled" ;;
    *)
      echo "  Invalid choice — defaulting to auto"
      PROVIDER="auto"
      ;;
  esac

  echo "  ▸ Using provider: ${PROVIDER}"
  echo ""

  # ── Model defaults (provider-specific) ──

  if [ "$PROVIDER" = "anthropic" ]; then
    MODEL="claude-haiku-4-5-20251001"
  elif [ "$PROVIDER" = "openai" ]; then
    read -r -p "  Model ID [gpt-4o-mini]: " MODEL_INPUT
    MODEL="${MODEL_INPUT:-gpt-4o-mini}"
    echo "  ▸ Model: ${MODEL}"
    echo ""
  fi

  # ── API key / baseURL prompts (provider-specific) ──
  # API keys are read from the environment only (never stored as plaintext).
  # config.ts expands ${VAR} placeholders in llm.apiKey at runtime.

  if [ "$PROVIDER" = "anthropic" ]; then
    if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
      echo "  ERROR: ANTHROPIC_API_KEY is not set in your environment."
      echo ""
      echo "  Export it first, then re-run setup:"
      echo "    export ANTHROPIC_API_KEY=your_api_key_here"
      echo ""
      exit 1
    fi
    echo "  ▸ Using ANTHROPIC_API_KEY from environment"
    # Write env-var placeholder — config.ts expands \${VAR} at runtime
    API_KEY='${ANTHROPIC_API_KEY}'
    echo ""
  fi

  if [ "$PROVIDER" = "openai" ]; then
    if [ -n "${OPENAI_API_KEY:-}" ]; then
      echo "  ▸ Using OPENAI_API_KEY from environment"
      # Write env-var placeholder — config.ts expands \${VAR} at runtime
      API_KEY='${OPENAI_API_KEY}'
    else
      echo "  ▸ OPENAI_API_KEY is not set; proceeding without an API key."
      echo "    (This is acceptable for some OpenAI-compatible local servers.)"
    fi

    read -r -p "  Base URL [https://api.openai.com/v1]: " BASE_URL_INPUT
    # Trim leading/trailing whitespace using pure bash parameter expansion
    BASE_URL_INPUT="${BASE_URL_INPUT:-https://api.openai.com/v1}"
    BASE_URL="${BASE_URL_INPUT#"${BASE_URL_INPUT%%[![:space:]]*}"}"
    BASE_URL="${BASE_URL%"${BASE_URL##*[![:space:]]}"}"
    # If trimmed value is empty (e.g., user entered only whitespace), fall back to default
    if [ -z "$BASE_URL" ]; then
      BASE_URL="https://api.openai.com/v1"
    fi
    echo "  ▸ Base URL: ${BASE_URL}"
    echo ""

    # Fail fast: public OpenAI API requires a key
    if [ -z "${API_KEY:-}" ] && [ "$BASE_URL" = "https://api.openai.com/v1" ]; then
      echo "  ERROR: OPENAI_API_KEY is required when using the public OpenAI API."
      echo ""
      echo "  Export it first, then re-run setup:"
      echo "    export OPENAI_API_KEY=your_api_key_here"
      echo ""
      exit 1
    fi
  fi
fi

# ── Validate config and establish the secure root ──
# Validation happens before root creation so a symlink or oversized file is
# reported without touching the user's existing state. The actual update is
# delegated to the guarded `lcm config set` path below; setup never performs a
# broad JSON rewrite itself.

node - "$CONFIG_FILE" <<'NODE'
const fs = require('fs');
const configFile = process.argv[2];
let fd;
try {
  const stat = fs.lstatSync(configFile);
  if (stat.isSymbolicLink()) throw new Error(`refusing to use symlink config path: ${configFile}`);
  if (!stat.isFile()) throw new Error(`config path is not a regular file: ${configFile}`);
  fd = fs.openSync(configFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const descriptorStat = fs.fstatSync(fd);
  if (!descriptorStat.isFile()) throw new Error('config path is not a regular file');
  const maxConfigBytes = 1024 * 1024;
  const chunks = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let total = 0;
  while (total <= maxConfigBytes) {
    const bytesRead = fs.readSync(fd, buffer, 0, Math.min(buffer.length, maxConfigBytes + 1 - total), null);
    if (bytesRead === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    total += bytesRead;
  }
  if (total > maxConfigBytes) throw new Error('config file exceeds 1 MiB');
  JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
} catch (err) {
  if (err && err.code === 'ENOENT') process.exit(0);
  if (err instanceof SyntaxError) {
    console.error(`Error: Failed to parse existing config at ${configFile}.`);
    console.error('The file contains invalid JSON. Fix or remove it, then re-run setup.');
  } else if (err instanceof Error && err.message.startsWith('refusing to use symlink config path:')) {
    console.error(`Error: ${err.message}`);
    console.error('Remove the symlink or replace it with a regular config file, then re-run setup.');
  } else if (err instanceof Error && err.message.startsWith('config path is not a regular file')) {
    console.error(`Error: ${err.message}`);
    console.error('Replace it with a regular config file, then re-run setup.');
  } else if (err instanceof Error && err.message === 'config file exceeds 1 MiB') {
    console.error(`Error: Existing config at ${configFile} exceeds the 1 MiB safety limit.`);
    console.error('Reduce the config file size, then re-run setup.');
  } else {
    console.error(`Error: Failed to read existing config at ${configFile}.`);
    console.error('Check that it is a readable regular file, then re-run setup.');
  }
  process.exit(1);
} finally {
  if (fd !== undefined) fs.closeSync(fd);
}
NODE

stat_owner() {
  if stat -c '%u' "$1" >/dev/null 2>&1; then
    stat -c '%u' "$1"
  else
    stat -f '%u' "$1"
  fi
}

stat_mode() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
  else
    stat -f '%Lp' "$1"
  fi
}

validate_home_directory() {
  if [ ! -d "$HOME" ] || [ -L "$HOME" ]; then
    echo "Error: HOME must be an existing non-symlink directory." >&2
    exit 1
  fi

  local home_owner home_mode home_mode_value
  home_owner="$(stat_owner "$HOME")"
  home_mode="$(stat_mode "$HOME")"
  if [ "$home_owner" != "$(id -u)" ] || ! [[ "$home_mode" =~ ^[0-7]{3,4}$ ]]; then
    echo "Error: HOME must be owned by the current user with a readable mode." >&2
    exit 1
  fi
  home_mode_value=$((8#$home_mode))
  if (( home_mode_value & 022 )); then
    echo "Error: HOME must not be group- or world-writable: $HOME" >&2
    exit 1
  fi
  if [ -L "$HOME" ]; then
    echo "Error: HOME changed to a symlink during validation." >&2
    exit 1
  fi
}

validate_private_root() {
  if [ -L "$CONFIG_DIR" ]; then
    echo "Error: refusing to use symlink LCM root: $CONFIG_DIR" >&2
    exit 1
  fi
  if [ ! -d "$CONFIG_DIR" ]; then
    echo "Error: LCM root is not a directory: $CONFIG_DIR" >&2
    exit 1
  fi
  local root_owner root_mode
  root_owner="$(stat_owner "$CONFIG_DIR")"
  root_mode="$(stat_mode "$CONFIG_DIR")"
  if [ "$root_owner" != "$(id -u)" ] || [ "$root_mode" != "700" ]; then
    echo "Error: LCM root must be owned by the current user with mode 0700: $CONFIG_DIR" >&2
    exit 1
  fi
  if [ -L "$CONFIG_DIR" ] || [ ! -d "$CONFIG_DIR" ]; then
    echo "Error: LCM root changed during validation: $CONFIG_DIR" >&2
    exit 1
  fi
}

ensure_secure_lcm_root() {
  validate_home_directory

  if [ -e "$LEGACY_CONFIG_DIR" ] || [ -L "$LEGACY_CONFIG_DIR" ]; then
    echo "Error: legacy LCM state exists at $LEGACY_CONFIG_DIR; refusing to create or update $CONFIG_DIR." >&2
    case "$(uname -s)" in
      Linux)
        echo "Run 'lcm install' to perform authenticated legacy migration through /proc/self/fd, then re-run setup." >&2
        ;;
      Darwin)
        echo "On macOS, lcm cannot perform this descriptor-bound legacy migration." >&2
        echo "Back up and rename $LEGACY_CONFIG_DIR out of the migration path; do not recursively delete it." >&2
        echo "Confirm $CONFIG_DIR does not exist; if it does, stop and preserve both directories. If it is absent, re-run setup." >&2
        ;;
      *)
        echo "Automatic legacy migration requires Linux-compatible /proc/self/fd descriptor access." >&2
        echo "Back up and rename $LEGACY_CONFIG_DIR out of the migration path; do not recursively delete it." >&2
        echo "Confirm $CONFIG_DIR does not exist; if it does, stop and preserve both directories. If it is absent, re-run setup." >&2
        ;;
    esac
    exit 1
  fi

  if [ -e "$CONFIG_DIR" ] || [ -L "$CONFIG_DIR" ]; then
    validate_private_root
    return
  fi

  # Non-recursive creation is intentional: HOME was authenticated above and
  # no intermediate pathname may be silently created or repaired. The umask
  # also protects the short interval before exact mode revalidation.
  umask 077
  mkdir "$CONFIG_DIR"
  validate_private_root
}

ensure_secure_lcm_root

# Re-open both authenticated directories through descriptors before publishing
# configuration. Some platforms/filesystems reject directory fsync; those
# explicit unsupported errors are treated as best-effort after identity and
# owner/mode validation, while all other open, witness, or fsync failures fail
# closed.
node - "$CONFIG_DIR" "$HOME" <<'NODE'
const fs = require('fs');
const [rootPath, homePath] = process.argv.slice(2);
const unsupportedDirectorySync = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP']);
const flags = fs.constants.O_RDONLY
  | (fs.constants.O_DIRECTORY || 0)
  | (fs.constants.O_NOFOLLOW || 0)
  | (fs.constants.O_NONBLOCK || 0);
const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : undefined;

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function syncDirectory(path, label, privateRoot) {
  let fd;
  try {
    fd = fs.openSync(path, flags);
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isDirectory()) throw new Error(`${label} is not a directory`);
    const current = fs.statSync(path, { bigint: true });
    if (!sameIdentity(opened, current)) throw new Error(`${label} changed during durable validation`);
    if (uid !== undefined && opened.uid !== uid) throw new Error(`${label} owner changed during durable validation`);
    const mode = Number(opened.mode & 0o7777n);
    if (privateRoot ? mode !== 0o700 : (mode & 0o022) !== 0) {
      throw new Error(`${label} mode changed during durable validation`);
    }
    try {
      fs.fsyncSync(fd);
    } catch (error) {
      if (!unsupportedDirectorySync.has(error && error.code)) throw error;
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

try {
  syncDirectory(rootPath, 'LCM root', true);
  syncDirectory(homePath, 'HOME directory', false);
} catch (error) {
  console.error(`Error: failed to durably validate the LCM root topology: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
NODE

LLM_JSON="$(node - "$PROVIDER" "$MODEL" "$API_KEY" "$BASE_URL" <<'NODE'
const [provider, model, apiKey, baseUrl] = process.argv.slice(2);
const llm = { provider };
if (model) llm.model = model;
if (apiKey) llm.apiKey = apiKey;
if (baseUrl) llm.baseUrl = baseUrl;
process.stdout.write(JSON.stringify(llm));
NODE
)"

lcm config set llm "$LLM_JSON" --json >/dev/null

if [ -t 0 ]; then
  echo "  ▸ Config written to ${CONFIG_FILE}"
  echo ""
fi

# ── Install hooks ──

if [ -t 0 ]; then echo "  ──── Installing hooks"; echo ""; fi
lcm install
if [ -t 0 ]; then echo ""; fi

# ── Verify ──

if [ -t 0 ]; then echo "  ──── Running lcm doctor"; echo ""; fi
lcm doctor
if [ -t 0 ]; then echo ""; fi

if [ -t 0 ]; then echo "  Setup complete."; echo ""; fi

exit 0
