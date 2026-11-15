#!/usr/bin/env bash
# Install DeepSeek Harness + the Operant profile on the cloud VM, including the
# keyless DuckDuckGo search provider. Runs as the login user (not root).
#
# Secrets: ~/.dsh/.credentials.yaml is copied by the operator beforehand and is
# never echoed, printed, or written to logs by this script.
set -euo pipefail
LOG=/var/log/operant-dsh-setup.log
sudo touch "$LOG" && sudo chown "$(id -u):$(id -g)" "$LOG" || LOG=/tmp/operant-dsh-setup.log
exec > >(tee -a "$LOG") 2>&1
echo "=== dsh setup start $(date -Is) ==="

SRC=/opt/operant/packages/web-search-ddg
PROFILE="$HOME/.dsh/profiles/operant"

# ---------------------------------------------------------------- dsh itself
if ! command -v dsh >/dev/null 2>&1; then
  echo "installing @deepseek-ai/dsh globally"
  sudo npm install -g @deepseek-ai/dsh >/dev/null 2>&1
fi
echo "dsh version: $(dsh --version 2>/dev/null || echo unknown)"
echo "node: $(node -v)"

# ---------------------------------------------------------------- credentials
if [ -f "$HOME/.dsh/.credentials.yaml" ]; then
  chmod 600 "$HOME/.dsh/.credentials.yaml"
  # Report only the KEY NAMES, never values.
  echo "credential keys present: $(grep -oE '^[[:space:]]*[A-Za-z0-9_-]+:' "$HOME/.dsh/.credentials.yaml" | tr -d ' :' | sort -u | tr '\n' ' ')"
else
  echo "WARN: no credentials file; model routes will fail with MISSING_CREDENTIAL"
fi

# ---------------------------------------------------------------- profile
# The profile files (cordis.yml, package.json, cordis.patch.yml) are uploaded by
# the operator. Here we only repair the one thing that must differ on Linux:
# the link target of the search provider, which is a Windows path in the repo copy.
mkdir -p "$PROFILE"
node -e '
const fs=require("fs"),p=process.argv[1];
const j=JSON.parse(fs.readFileSync(p+"/package.json","utf8"));
j.dependencies=j.dependencies||{};
j.dependencies["@operant/web-search-ddg"]="link:/opt/operant/packages/web-search-ddg";
j.packageManager="pnpm@11.19.0";
fs.writeFileSync(p+"/package.json",JSON.stringify(j,null,2));
console.log("profile package.json link -> /opt/operant/packages/web-search-ddg");
' "$PROFILE"

# pnpm via corepack if absent
command -v pnpm >/dev/null 2>&1 || sudo npm install -g pnpm@11.19.0 >/dev/null 2>&1

echo "--- installing profile deps ---"
(cd "$PROFILE" && pnpm install --silent 2>&1 | tail -3) || echo "WARN: pnpm install reported an issue"

# The provider's dist/ is built on the operator machine and uploaded, so no tsc
# is required here. Assert it is actually present rather than assuming.
if [ -f "$SRC/dist/index.js" ]; then
  echo "provider dist present: $(wc -c < "$SRC/dist/index.js") bytes"
else
  echo "ERROR: $SRC/dist/index.js missing - search provider cannot load"
  exit 1
fi

# ---------------------------------------------------------------- verification
echo "--- composed config check ---"
DUMP=$(dsh --profile operant --dump-config < /dev/null 2>&1 || true)
echo "composed lines: $(printf '%s\n' "$DUMP" | wc -l)"
echo "genuine warn/error: $(printf '%s\n' "$DUMP" | grep -cE '^\s*(WARN|ERROR)|not found|Cannot find' || true)"
printf '%s\n' "$DUMP" | grep -E 'searchProvider|web-search-ddg' | sed 's/^/  /' || true

echo "--- live headless execution test ---"
dsh --profile operant --json "Reply with exactly: OPERANT-CLOUD-OK" < /dev/null 2>&1 | tail -3

echo "--- search provider test ---"
dsh --profile operant --json "Call web_search once with query 'DeepSeek Harness'. Report the tool name, sources count, and first source title. If it fails, quote the exact error." < /dev/null 2>&1 | tail -2

echo "=== dsh setup done $(date -Is) ==="