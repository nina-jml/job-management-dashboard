#!/usr/bin/env bash
#
# timelog.sh — minimal time tracker for this project.
#
#   ./scripts/timelog.sh start "step 0 — walking skeleton"
#   ./scripts/timelog.sh stop  "cold gate green"
#   ./scripts/timelog.sh status
#   ./scripts/timelog.sh report
#
# Ledger is docs/time_log.tsv (append-only, source of truth).
# docs/TIME_LOG.md is rendered from it and is safe to overwrite.
#
# Epoch seconds are stored alongside the ISO strings so duration arithmetic is
# pure integer math — BSD `date` (macOS) and GNU `date` (Linux) disagree on how
# to parse a timestamp back into epoch, and this sidesteps that entirely.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LEDGER="$ROOT/docs/time_log.tsv"
ACTIVE="$ROOT/docs/.timelog.active"
REPORT="$ROOT/docs/TIME_LOG.md"

now_epoch() { date +%s; }
now_iso()   { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

# Zone the *report* is rendered in. The ledger keeps UTC, which is the right
# storage format — unambiguous and immune to DST. But rendering UTC to a human
# is actively misleading: a session worked on the evening of the 25th showed up
# as "2026-07-26 00:09", wrong by a whole day. Override with REPORT_TZ.
REPORT_TZ="${REPORT_TZ:-America/Los_Angeles}"

# Epoch -> "YYYY-MM-DD HH:MM" in REPORT_TZ.
#
# BSD date (macOS) reads an epoch with -r; GNU date wants -d @EPOCH, and treats
# -r as "reference file" so it fails through to the fallback. The ledger stores
# the epoch alongside the ISO string precisely so this never parses a string
# back — which is the operation the two implementations disagree about.
local_stamp() {
  TZ="$REPORT_TZ" date -r "$1" +"%Y-%m-%d %H:%M" 2>/dev/null \
    || TZ="$REPORT_TZ" date -d "@$1" +"%Y-%m-%d %H:%M"
}

zone_abbrev() {
  TZ="$REPORT_TZ" date -r "$1" +%Z 2>/dev/null || TZ="$REPORT_TZ" date -d "@$1" +%Z
}

# Seconds -> "2h 35m"
human() {
  local s=$1
  printf '%dh %02dm' $((s / 3600)) $(((s % 3600) / 60))
}

ensure_ledger() {
  if [ ! -f "$LEDGER" ]; then
    printf 'start_epoch\tend_epoch\tstart_iso\tend_iso\tlabel\n' >"$LEDGER"
  fi
}

cmd_start() {
  local label="${1:-unlabelled}"
  if [ -f "$ACTIVE" ]; then
    echo "✗ A session is already running:" >&2
    cmd_status >&2
    echo "  Run 'stop' before starting another." >&2
    exit 1
  fi
  ensure_ledger
  printf '%s\t%s\t%s\n' "$(now_epoch)" "$(now_iso)" "$label" >"$ACTIVE"
  echo "▶ started · $label · $(now_iso)"
}

cmd_stop() {
  local note="${1:-}"
  if [ ! -f "$ACTIVE" ]; then
    echo "✗ No session running. Nothing to stop." >&2
    exit 1
  fi
  ensure_ledger

  local start_epoch start_iso label end_epoch end_iso elapsed
  IFS=$'\t' read -r start_epoch start_iso label <"$ACTIVE"
  end_epoch="$(now_epoch)"
  end_iso="$(now_iso)"
  elapsed=$((end_epoch - start_epoch))

  [ -n "$note" ] && label="$label — $note"

  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$start_epoch" "$end_epoch" "$start_iso" "$end_iso" "$label" >>"$LEDGER"
  rm -f "$ACTIVE"

  echo "■ stopped · $(human "$elapsed") · $label"
  cmd_report >/dev/null
  echo "  total: $(total_human)"
}

total_seconds() {
  ensure_ledger
  awk -F'\t' 'NR>1 { t += ($2 - $1) } END { print t+0 }' "$LEDGER"
}

total_human() { human "$(total_seconds)"; }

cmd_status() {
  if [ -f "$ACTIVE" ]; then
    local start_epoch start_iso label elapsed
    IFS=$'\t' read -r start_epoch start_iso label <"$ACTIVE"
    elapsed=$(($(now_epoch) - start_epoch))
    echo "▶ ACTIVE · $label · running $(human "$elapsed") (since $start_iso)"
  else
    echo "■ idle"
  fi
  echo "  logged total: $(total_human)"
}

cmd_report() {
  ensure_ledger
  {
    echo "# Time Log"
    echo
    echo "Rendered from \`docs/time_log.tsv\` by \`scripts/timelog.sh report\` (or \`make time\`)."
    echo "Do not edit by hand — edit the ledger instead."
    echo
    echo "Times are **$(zone_abbrev "$(now_epoch)")** (\`$REPORT_TZ\`). The ledger stores UTC;"
    echo "only this rendering is local."
    echo
    echo "| Date | Start | End | Duration | Work |"
    echo "|---|---|---|---|---|"
    local s_epoch e_epoch s_iso e_iso label dur s_stamp e_stamp
    while IFS=$'\t' read -r s_epoch e_epoch s_iso e_iso label; do
      [ "$s_epoch" = "start_epoch" ] && continue
      [ -z "$s_epoch" ] && continue
      dur=$((e_epoch - s_epoch))
      s_stamp="$(local_stamp "$s_epoch")"
      e_stamp="$(local_stamp "$e_epoch")"
      printf '| %s | %s | %s | %s | %s |\n' \
        "${s_stamp%% *}" "${s_stamp##* }" "${e_stamp##* }" "$(human "$dur")" "$label"
    done <"$LEDGER"

    if [ -f "$ACTIVE" ]; then
      local a_epoch a_iso a_label a_elapsed a_stamp
      IFS=$'\t' read -r a_epoch a_iso a_label <"$ACTIVE"
      a_elapsed=$(($(now_epoch) - a_epoch))
      a_stamp="$(local_stamp "$a_epoch")"
      printf '| %s | %s | — | **%s (active)** | %s |\n' \
        "${a_stamp%% *}" "${a_stamp##* }" "$(human "$a_elapsed")" "$a_label"
    fi

    echo
    echo "**Total logged: $(total_human)**"
    echo
    echo "This total is the figure reported in \`README.md\` as time spent on the assignment."
  } >"$REPORT"

  cat "$REPORT"
}

case "${1:-status}" in
  start)  shift; cmd_start "$@"  ;;
  stop)   shift; cmd_stop  "$@"  ;;
  status) cmd_status ;;
  report) cmd_report ;;
  *)
    echo "usage: $0 {start <label>|stop [note]|status|report}" >&2
    exit 2
    ;;
esac
