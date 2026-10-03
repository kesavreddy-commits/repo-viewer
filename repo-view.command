#!/bin/zsh -l
# Opens Claude Code with the repo-view mod in the repo you pass (default: this one).
# Double-click it in Finder, or: ./repo-view.command ~/some/repo
MOD="${0:A:h}"
cd "${1:-$MOD}" || exit 1
# Widen the window so the pane docks beside the transcript (xterm window op; Terminal.app honours it).
printf '\e[8;52;200t'
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
exec claude --plugin-dir "$MOD" --settings '{"tui":"fullscreen"}'
