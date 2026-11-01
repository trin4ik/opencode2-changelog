#!/usr/bin/env bash
# Runs inside the test/install.Dockerfile container: installs the plugin the README way and opens /changelog in the TUI.
# /src is the plugin repository, mounted read-only; its committed HEAD is what gets installed.
set -euo pipefail

screen() { tmux capture-pane -pt tui 2>/dev/null || true; }
fail() {
  echo "✗ $1"
  echo "--- TUI screen ---"
  screen
  exit 1
}
# wait_for <text> <seconds>
wait_for() {
  for _ in $(seq 1 $(($2 * 5))); do
    screen | grep -qF "$1" && return 0
    sleep 0.2
  done
  return 1
}

echo "• OpenCode $(opencode --version)"
git config --global --add safe.directory '*'
git clone --quiet /src ~/.local/share/opencode2-changelog
node ~/.local/share/opencode2-changelog/scripts/install.mjs

mkdir -p ~/project
tmux new-session -d -s tui -x 140 -y 45 -c ~/project opencode
wait_for "ctrl+p" 60 || fail "the TUI did not start"
tmux send-keys -t tui "/changelog"
sleep 1
tmux send-keys -t tui Enter
# The first Enter may only accept the slash-command completion.
wait_for "What's new" 3 || tmux send-keys -t tui Enter
wait_for "What's new · 2." 60 || fail "/changelog did not show release notes"
screen | grep -F "What's new · 2."
echo "✓ installed and working"
