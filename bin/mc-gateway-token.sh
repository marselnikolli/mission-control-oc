#!/usr/bin/env bash
# Deployment helper: makes sure .env has a usable OPENCLAW_GATEWAY_TOKEN before Mission
# Control starts, by resolving the token the OpenClaw Gateway is already configured with --
# or, if none is configured anywhere, generating a persistent one for both sides.
#
# Resolution order (first non-empty wins):
#   1. OPENCLAW_GATEWAY_TOKEN already exported in the caller's environment
#   2. `openclaw gateway auth-token --show` (resolves gateway.auth.token, OPENCLAW_GATEWAY_TOKEN,
#      and configured SecretRefs; run under a PTY because it refuses piped/redirected output)
#   3. Plain-string gateway.auth.token read directly from the OpenClaw config file
#
# Generation (only when nothing resolved):
#   1. `openclaw doctor --generate-gateway-token`, which persists a token into the config
#   2. Fallback (no CLI/Node or immutable config): generate a random token ourselves and, when
#      a writable plain config is reachable, store it there too -- then warn that the Gateway
#      must be restarted to pick it up.
#
# Idempotent: if .env already has a non-empty token it exits 0 untouched. Use --force to
# regenerate. The Gateway must be restarted after any regeneration so the running daemon binds
# the new shared token (a runtime-only token is ephemeral and can never be recovered).
set -euo pipefail

cd "$(dirname "$0")/.."

force=0
dry_run=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --force) force=1 ;;
    --dry-run) dry_run=1 ;;
    *) echo "usage: $0 [--force] [--dry-run]" >&2; exit 2 ;;
  esac
  shift
done

say()  { [ "$dry_run" -eq 0 ] || printf '[dry-run] '; printf '%s\n' "$*"; }

env_file="$PWD/.env"
example_file="$PWD/.env.example"

# --- helpers ----------------------------------------------------------------

# Look for openclaw.json respecting the usual config/profile locations.
openclaw_config_paths() {
  [ -n "${OPENCLAW_CONFIG:-}" ] && printf '%s\n' "$OPENCLAW_CONFIG"
  printf '%s\n' "$HOME/.openclaw/openclaw.json"
  [ -n "${OPENCLAW_PROFILE:-}" ] && printf '%s\n' "$HOME/.openclaw/profiles/$OPENCLAW_PROFILE/openclaw.json"
  printf '%s\n' "$HOME/.openclaw/profiles/default/openclaw.json"
}

config_token=""
config_path=""
for p in $(openclaw_config_paths); do
  [ -f "$p" ] || continue
  if command -v node >/dev/null 2>&1; then
    got="$(node -e '
      const fs = require("fs"); const p = process.argv[1];
      try {
        const j = JSON.parse(fs.readFileSync(p, "utf8"));
        const t = j.gateway && j.gateway.auth && j.gateway.auth.token;
        if (typeof t === "string" && t) process.stdout.write(t);
      } catch (e) {}
    ' "$p" 2>/dev/null || true)"
    # Only treat it as our source if it really contained the token -- otherwise keep scanning
    # so a later profile wins instead of the first empty file.
    if [ -n "$got" ]; then
      config_path="$p"
      config_token="$got"
      break
    fi
  fi
done

cli_token=""
if command -v openclaw >/dev/null 2>&1; then
  if command -v script >/dev/null 2>&1; then
    raw="$(script -qec 'openclaw gateway auth-token --show' /dev/null 2>/dev/null || true)"
    cli_token="$(printf '%s' "$raw" \
      | sed 's/\r//g' \
      | sed -E 's/\x1B\[[0-9;]*[A-Za-z]//g' \
      | grep -v '^[[:space:]]*$' \
      | tail -n 1 || true)"
    # auth-token --show prints only the token; if the last line isn't token-ish, ignore it.
    case "$cli_token" in
      ''|*' '*):;;
      *) [ "${#cli_token}" -lt 8 ] && cli_token="" ;;
    esac
  fi
fi

resolve_existing() {
  if [ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
    printf '%s' "$OPENCLAW_GATEWAY_TOKEN"; return 0
  fi
  if [ -n "$cli_token" ]; then printf '%s' "$cli_token"; return 0; fi
  if [ -n "$config_token" ]; then printf '%s' "$config_token"; return 0; fi
  return 0
}

token="$(resolve_existing)"

# --- already provisioned? ---------------------------------------------------

existing_env_token=""
if [ -f "$env_file" ]; then
  existing_env_token="$(awk '!/^[[:space:]]*#/ && /^OPENCLAW_GATEWAY_TOKEN=/{sub(/^OPENCLAW_GATEWAY_TOKEN=/,""); print}' "$env_file" | tail -n 1)"
fi

if [ -n "$existing_env_token" ] && [ "$force" -eq 0 ]; then
  say "OPENCLAW_GATEWAY_TOKEN already set in $env_file (${#existing_env_token} chars) -- leaving it alone. Use --force to regenerate."
  exit 0
fi

# --- generate when nothing exists (or --force) ------------------------------

if [ -z "$token" ] || [ "$force" -eq 1 ]; then
  token="" # discard any stale resolved token so --force starts clean
  if command -v openclaw >/dev/null 2>&1; then
    say "no token found in env/CLI/config -- running 'openclaw doctor --generate-gateway-token' to create one (headless, prompts skipped)..."
    openclaw doctor --generate-gateway-token 2>&1 | sed 's/^/  /' || true
    # Re-resolve: the doctor run persisted a token into the config (or refused because a
    # SecretRef owns it, in which case the CLI resolution below/further down reports that).
    cli_token=""
    if command -v script >/dev/null 2>&1; then
      raw="$(script -qec 'openclaw gateway auth-token --show' /dev/null 2>/dev/null || true)"
      cli_token="$(printf '%s' "$raw" | sed 's/\r//g' | sed -E 's/\x1B\[[0-9;]*[A-Za-z]//g' | grep -v '^[[:space:]]*$' | tail -n 1 || true)"
      case "$cli_token" in
        ''|*' '*):;;
        *) [ "${#cli_token}" -lt 8 ] && cli_token="" ;;
      esac
    fi
    config_token=""
    for p in $(openclaw_config_paths); do
      [ -f "$p" ] || continue
      got="$(node -e '
        const fs = require("fs"); const p = process.argv[1];
        try {
          const j = JSON.parse(fs.readFileSync(p, "utf8"));
          const t = j.gateway && j.gateway.auth && j.gateway.auth.token;
          if (typeof t === "string" && t) process.stdout.write(t);
        } catch (e) {}
      ' "$p" 2>/dev/null || true)"
      if [ -n "$got" ]; then config_path="$p"; config_token="$got"; break; fi
    done
    token="$(resolve_existing)"
  fi
fi

made_token=0
if [ -z "$token" ]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: no token anywhere (not in env, not in OpenClaw config, and the openclaw/Node CLIs" >&2
    echo "       are unavailable), so nothing can generate one on this host." >&2
    echo "       On the Gateway host run: openclaw doctor --generate-gateway-token" >&2
    exit 1
  fi
  token="$(node -e 'console.log(require("crypto").randomBytes(48).toString("hex"))')"
  made_token=1
  say "generated a new random token (${#token} chars) -- configuring it for Gateway + Mission Control."

  if [ -n "$config_path" ]; then
    if command -v node >/dev/null 2>&1 && grep -q '\$include' "$config_path" 2>/dev/null; then
      say "  note: $config_path uses \$include -- not editing a composed config, keeping token in .env only."
    elif node -e '
        const fs = require("fs");
        const p = process.argv[1], tok = process.argv[2];
        const j = JSON.parse(fs.readFileSync(p, "utf8"));
        if (!j.gateway) j.gateway = {};
        if (!j.gateway.auth) j.gateway.auth = {};
        const cur = j.gateway.auth.token;
        if (cur && cur !== tok) { process.exit(2); }  // existing plaintext or SecretRef -> hands off
        fs.writeFileSync(p + ".bak", fs.readFileSync(p));
        j.gateway.auth.token = tok;
        fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
        process.exit(0);
      ' "$config_path" "$token"; then
      say "  wrote token to $config_path (backup: $config_path.bak)"
    else
      say "  note: $config_path has a token managed elsewhere (e.g. SecretRef) -- token kept in .env only."
    fi
  else
    say "  note: no OpenClaw config file found under ~/.openclaw -- token kept in .env only."
    say "  make sure the Gateway uses OPENCLAW_GATEWAY_TOKEN=$token or set gateway.auth.token to match."
  fi
fi

# --- write into .env -------------------------------------------------------

if [ "$dry_run" -eq 1 ]; then
  say "would set OPENCLAW_GATEWAY_TOKEN=$token in $env_file"
  exit 0
fi

if [ ! -f "$env_file" ]; then
  if [ -f "$example_file" ]; then
    cp "$example_file" "$env_file"
    say "created $env_file from .env.example"
  else
    : > "$env_file"
    say "created $env_file"
  fi
fi

tmp_env="${env_file}.tmp"
awk -v v="$token" '
  /^OPENCLAW_GATEWAY_TOKEN=/ { print "OPENCLAW_GATEWAY_TOKEN=" v; done = 1; next }
  { print }
  END { if (!done) print "OPENCLAW_GATEWAY_TOKEN=" v }
' "$env_file" > "$tmp_env"
mv "$tmp_env" "$env_file"
chmod 600 "$env_file"

say "set OPENCLAW_GATEWAY_TOKEN=${#token} chars in $env_file"

if [ "$made_token" -eq 1 ]; then
  echo
  echo "!! The Gateway daemon must be restarted so it binds the new shared token:" >&2
  echo "   openclaw gateway restart   (or: systemctl --user restart <openclaw-service>)   (or: docker restart openclaw)" >&2
fi