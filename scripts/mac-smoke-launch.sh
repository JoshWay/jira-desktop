#!/usr/bin/env bash
# Launches a packaged Jira Desktop .app on a throwaway profile and fails unless it finishes startup
# and keeps running. Used by CI (.github/workflows/release.yml) on every macOS run, signed or not.
#
# Usage: scripts/mac-smoke-launch.sh "<path to Jira Desktop.app>"
#
# Why: the fuses (asar integrity, only-load-from-asar) and the hardened runtime apply only to a
# packaged build, which the e2e tests never run, and Playwright cannot drive it (the --inspect fuse
# is off). With JIRA_DESKTOP_SMOKE_TEST=1 the app writes <profile>/smoke-startup-complete once its
# startup ran without throwing (src/main/main.ts). Being alive is not enough on its own: a
# main-process exception shows an error dialog and leaves the process running.
#
# The app runs with a stripped environment (no CI tokens or secrets), on a new empty profile, so
# it shows the local welcome dialog and loads no site. A packaged build checks GitHub's public
# releases for updates a few seconds in; it keeps running whatever that check finds.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <path to Jira Desktop.app>" >&2
  exit 2
fi
app=$1
bin="$app/Contents/MacOS/Jira Desktop"
if [ ! -x "$bin" ]; then
  echo "::error title=Smoke launch::no executable at $bin" >&2
  exit 1
fi

work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/jira-desktop-smoke.XXXXXX")
profile="$work/profile"
log="$work/app.log"
mkdir "$profile"
marker="$profile/smoke-startup-complete"

env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin TMPDIR="${TMPDIR:-/tmp}" \
  JIRA_DESKTOP_USER_DATA_DIR="$profile" JIRA_DESKTOP_SMOKE_TEST=1 \
  "$bin" >"$log" 2>&1 &
pid=$!

started=false
for _ in $(seq 1 90); do
  if ! kill -0 "$pid" 2>/dev/null; then break; fi
  if [ -f "$marker" ]; then started=true; break; fi
  sleep 1
done
# A few more seconds, so a crash just after startup still fails
if [ "$started" = true ]; then sleep 5; fi
alive=false
if kill -0 "$pid" 2>/dev/null; then alive=true; fi
kill "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true

if [ "$started" != true ] || [ "$alive" != true ]; then
  echo "::error title=Smoke launch::the packaged app did not finish startup and stay running (startup complete: $started, alive: $alive)"
  echo "--- app output"
  cat "$log"
  exit 1
fi
echo "Smoke launch passed: $app finished startup and stayed running"
