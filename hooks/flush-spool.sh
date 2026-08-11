#!/bin/sh
# SessionStart hook. Resends notes that could not reach the aggregator earlier — the member
# was offline, off the VPN, or the endpoint was down.
#
# This exists because for a while it did not, and that was a real hole rather than a missing
# nicety: post-note.sh spools, and the only flusher was the Node one. On a machine with a
# shell and no Node — precisely the machine the shell sender exists to serve — notes were
# spooled and then never sent again. Silent and permanent, which is the failure mode this
# whole design is built to avoid.
#
# Both senders spool the same `.head` + `.body` pair, so either flusher drains either spool.

set -u
SPOOL="$HOME/.agent-knowledge-spool"
LOG="${TMPDIR:-/tmp}/agent-knowledge-hook.log"
MAX=25
log() { printf '%s [flush] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG" 2>/dev/null || true; }

ingest="${AGENT_KNOWLEDGE_INGEST:-}"
[ -n "$ingest" ] || exit 0
[ -d "$SPOOL" ] || exit 0
ingest="${ingest%/}"

n=0
attempted=0
for head in "$SPOOL"/*.head; do
  [ -f "$head" ] || continue
  n=$((n + 1))
  [ "$n" -gt "$MAX" ] && break
  body="${head%.head}.body"
  id="$(basename "$head" .head)"
  if [ ! -f "$body" ]; then
    rm -f "$head"
    log "$id: no body, discarded"
    continue
  fi

  # POSIX sh has no arrays; `set --` builds the argument list one header at a time. Values
  # are base64 or plain ASCII, so nothing here needs escaping.
  set --
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    set -- "$@" -H "$line"
  done < "$head"

  attempted=$((attempted + 1))
  code="$(cat "$body" | curl -sS -o /dev/null -w '%{http_code}' --max-time 3 -X POST \
    --data-binary @- -H "Content-Type: text/markdown; charset=utf-8" "$@" \
    "$ingest/note" 2>/dev/null)" || code="000"

  case "$code" in
    2*) rm -f "$head" "$body"; log "$id: delivered" ;;
    # 4xx means the endpoint judged it unacceptable and always will, so keeping it would
    # retry the same rejection at the start of every session from now on.
    4*) rm -f "$head" "$body"; log "$id: refused $code, discarded" ;;
    *)  log "$id: kept (http $code)" ;;
  esac
done

left=0
for f in "$SPOOL"/*.head; do [ -f "$f" ] && left=$((left + 1)); done
[ "$attempted" -gt 0 ] && log "$attempted attempted, $left still queued"
exit 0
