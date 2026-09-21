#!/usr/bin/env bash
# PostToolUse hook: auto-format and auto-fix lint issues on files written/edited by Claude.
# oxlint/oxfmt skip unsupported file types on their own, so no extension filtering is needed here.
set -euo pipefail

file_path="$(jq -r '.tool_input.file_path // empty')"

[ -z "$file_path" ] && exit 0
[ -f "$file_path" ] || exit 0

cd "${CLAUDE_PROJECT_DIR:-.}"

pnpm exec oxfmt --no-error-on-unmatched-pattern --write "$file_path" >/dev/null 2>&1 || true
pnpm exec oxlint --no-error-on-unmatched-pattern --fix "$file_path" >/dev/null 2>&1 || true

lint_output="$(pnpm exec oxlint --no-error-on-unmatched-pattern "$file_path" 2>&1)" || {
  echo "$lint_output" >&2
  exit 2
}

exit 0
