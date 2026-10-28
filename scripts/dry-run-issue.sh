#!/usr/bin/env bash
# 本機模擬一張申請 issue：在暫存目錄套用 issue 內容並跑註冊驗證，不會動到 repo。
#   scripts/dry-run-issue.sh add  path/to/issue-body.md
#   scripts/dry-run-issue.sh remove path/to/issue-body.md
set -euo pipefail

request="${1:?用法: $0 add|update|remove ISSUE_BODY_FILE}"
body_file="${2:?用法: $0 add|update|remove ISSUE_BODY_FILE}"
repo="$(cd "$(dirname "$0")/.." && pwd)"
sandbox="$(mktemp -d)"
trap 'rm -rf "$sandbox"' EXIT

cp -R "$repo/products" "$repo/schemas" "$sandbox/"
cd "$sandbox"

ISSUE_LABELS="[\"api-registration\",\"request:$request\"]" \
ISSUE_BODY="$(cat "$repo/$body_file" 2>/dev/null || cat "$body_file")" \
  node "$repo/scripts/issue-to-files.mjs"

echo "--- 與 repo 現況的差異 ---"
diff -ru "$repo/products" products || true
echo "--- 註冊驗證 ---"
node "$repo/scripts/validate.mjs" "$sandbox"
