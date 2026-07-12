#!/bin/sh
# Status line for Claude Code
input=$(cat)

# Extract every field in one jq invocation so we don't fork the process
# six times per status-line redraw.
IFS='	' read -r model used total_in total_out five_pct five_resets <<EOF
$(echo "$input" | jq -r '
  [
    .model.display_name // "",
    (.context_window.used_percentage // ""|tostring),
    (.context_window.total_input_tokens // ""|tostring),
    (.context_window.total_output_tokens // ""|tostring),
    (.rate_limits.five_hour.used_percentage // ""|tostring),
    (.rate_limits.five_hour.resets_at // ""|tostring)
  ] | @tsv
')
EOF

# Cheap numeric check: returns 0 (true) if $1 is a non-empty decimal,
# else 1. Guards against jq emitting non-numeric strings ("--", "n/a")
# which would otherwise blow up printf '%.0f' with "invalid number" on
# every status-line redraw, polluting the UI on every turn.
is_numeric() {
    case "${1:-}" in
        ''|*[!0-9.]*|.|*..*) return 1 ;;
        *) return 0 ;;
    esac
}

# Model name in yellow
[ -n "$model" ] && printf '\033[00;33m[%s]\033[00m' "$model"

# Context used percentage in cyan
if is_numeric "$used"; then
    printf ' \033[00;36mctx:%s%%\033[00m' "$(printf '%.0f' "$used")"
fi

# Cumulative token counts (input in dim white, output in dim white)
if [ -n "$total_in" ] || [ -n "$total_out" ]; then
    in_val=${total_in:-0}
    out_val=${total_out:-0}
    # Format with k suffix for thousands. Pass via -v so awk parses the
    # value as a variable rather than interpolating into program text;
    # the latter would let any non-numeric jq output execute as awk code.
    in_fmt=$(awk -v v="$in_val" 'BEGIN { if(v+0>=1000) printf "%.1fk", v/1000; else printf "%d", v+0 }')
    out_fmt=$(awk -v v="$out_val" 'BEGIN { if(v+0>=1000) printf "%.1fk", v/1000; else printf "%d", v+0 }')
    printf ' \033[02;37min:%s out:%s\033[00m' "$in_fmt" "$out_fmt"
fi

# Rate limit: 5-hour used percentage and reset time
if is_numeric "$five_pct"; then
    pct_fmt=$(printf '%.0f' "$five_pct")
    printf ' \033[00;35m5h:%s%%\033[00m' "$pct_fmt"
    if is_numeric "$five_resets"; then
        now=$(date +%s)
        secs_left=$(( five_resets - now ))
        if [ "$secs_left" -le 0 ]; then
            printf ' \033[02;35m(now)\033[00m'
        elif [ "$secs_left" -lt 3600 ]; then
            mins=$(( secs_left / 60 ))
            printf ' \033[02;35m(%dm)\033[00m' "$mins"
        else
            hrs=$(( secs_left / 3600 ))
            mins=$(( (secs_left % 3600) / 60 ))
            printf ' \033[02;35m(%dh%dm)\033[00m' "$hrs" "$mins"
        fi
    fi
fi
