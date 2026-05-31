#!/bin/bash
# SessionStart hook: install npm dependencies so tests, linters, and the husky
# pre-commit hooks (prettier --write via lint-staged) are active during the
# session. Without this, a fresh web container has no node_modules, husky never
# wires up core.hooksPath, and commits skip Prettier — failing CI "Lint & Format".
set -euo pipefail

# Only run in Claude Code on the web; local sessions already have deps installed.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

# `npm install` (not `npm ci`) so the cached container layer is reused on resume.
# The "prepare": "husky" script runs as part of install and sets core.hooksPath,
# activating the pre-commit Prettier/eslint hooks.
npm install --no-audit --no-fund
