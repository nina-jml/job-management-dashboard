#!/usr/bin/env bash
#
# timelog.sh — minimal time tracker for this project.
#
#   ./scripts/timelog.sh start "slice 0 — walking skeleton"
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
    echo "| Date | Start | End | Duration | Work |"
    echo "|---|---|---|---|---|"
    awk -F'\t' 'NR>1 {
      dur = $2 - $1
      printf "| %s | %s | %s | %dh %02dm | %s |\n", \
        substr($3,1,10), substr($3,12,5), substr($4,12,5), \
        dur/3600, (dur%3600)/60, $5
    }' "$LEDGER"

    if [ -f "$ACTIVE" ]; then
      local a_epoch a_iso a_label a_elapsed
      IFS=$'\t' read -r a_epoch a_iso a_label <"$ACTIVE"
      a_elapsed=$(($(now_epoch) - a_epoch))
      printf '| %s | %s | — | **%s (active)** | %s |\n' \
        "${a_iso:0:10}" "${a_iso:11:5}" "$(human "$a_elapsed")" "$a_label"
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
