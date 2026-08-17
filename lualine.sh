#!/usr/bin/env bash
# lualine.sh — nvim/lualine-style powerline status line for Claude Code.
# Reads Claude Code JSON from stdin. Segments (left → right):
#   [vim] branch(+dirty)  dir  session  5h  weekly  context  tokens
# Powerline separators require a Nerd Font (same as lualine in nvim).

# UTF-8 locale so ${#var} counts display columns (glyphs), not bytes.
export LC_ALL="${LC_ALL:-en_US.UTF-8}" LANG="${LANG:-en_US.UTF-8}"

input=$(cat)

# ── Powerline glyphs & icons (Nerd Font) ─────────────────────────────────────
SEP=$''      # right-filled separator
SUBSEP=$''   # right-thin separator
I_GIT=$''    # branch
I_DIR=$''    # folder
I_CTX=$''  # brain — context window (nf-fa-brain U+EE9C)

# ── 256-colour palette (lualine-ish) ─────────────────────────────────────────
# fg/bg helpers: fg <n>, bg <n>
fg() { printf '\033[38;5;%sm' "$1"; }
bg() { printf '\033[48;5;%sm' "$1"; }
RESET=$'\033[0m'
BOLD=$'\033[1m'

# Claude / earth theme — one warm Anthropic ramp, no cool hues.
# 256-colour approximations of the Anthropic palette: clay/crail #CC785C≈173,
# kraft #D4A27F≈180, manila #EBDBBC≈223, cream #F0EEE6≈230, ink #262624≈235.
# Identity group — light warm accents (clay → kraft → manila), all ink text.
DARK_FG=235        # near-black ink text on the light warm accents
LIGHT_FG=230       # cream text on the dark meter blocks
BR_BG=180          # kraft — one warm step lighter than clay
BR_FG=235          # ink
DIR_BG=223         # manila — lightest warm step, closes the identity ramp
DIR_FG=235         # ink
TAIL_BG=234        # ink backdrop for final cap

# Meter group — warm earthy bases (kraft-brown / sienna / mauve-brown) with a
# Claude-orange session pop; each metric a distinct warm step, all ramping
# through clay → barn red as they fill. No greens/greys — stays on-palette.
SESS_BG=208        # Claude orange — current session, made to POP
BASE_5H=137        # kraft brown
BASE_WK=138        # dusty rose-brown — weekly cap; calm, no red/yellow cast
BASE_CTX=130       # burnt sienna
BASE_TOK=172       # dark orange — session tokens + cost tail
AMBER=173          # shared "warming" colour (≥70%) — Claude clay
HOT=124            # shared "danger" colour (≥90%) — barn red

# ── Extract fields from stdin JSON ────────────────────────────────────────────
raw_cwd=$(printf '%s' "$input" | jq -r '.cwd // .workspace.current_dir // empty' 2>/dev/null)
[ -z "$raw_cwd" ] && raw_cwd="$PWD"
dir_name=$(basename "$raw_cwd")

# Vim editing mode — present only when vim mode is enabled (/vim). Lualine's
# signature leftmost block: colour tracks the mode so it reads at a glance.
vim_mode=$(printf '%s' "$input" | jq -r '.vim.mode // empty' 2>/dev/null)
case "$vim_mode" in
  NORMAL)  vim_bg=173 ;;   # clay
  INSERT)  vim_bg=179 ;;   # sand / gold
  VISUAL*) vim_bg=216 ;;   # peach
  REPLACE) vim_bg=124 ;;   # barn red
  *)       vim_bg=173 ;;
esac

# Context window percentage (0 if unavailable).
ctx=$(printf '%s' "$input" | jq -r '
  (.context_window.used_percentage) //
  ( (.context_window.context_window_size // 0) as $s |
    if $s > 0 then
      (((.context_window.current_usage.input_tokens // 0)
        + (.context_window.current_usage.cache_creation_input_tokens // 0)
        + (.context_window.current_usage.cache_read_input_tokens // 0)) / $s * 100)
    else 0 end )
' 2>/dev/null)
ctx=$(printf '%.0f' "${ctx:-0}" 2>/dev/null || echo 0)
[ "$ctx" -gt 100 ] 2>/dev/null && ctx=100

# meter_bg <percent> <base-hue> → base at low load, amber ≥70%, red ≥90%.
meter_bg() {
  if   [ "$1" -ge 90 ] 2>/dev/null; then echo "$HOT"
  elif [ "$1" -ge 70 ] 2>/dev/null; then echo "$AMBER"
  else echo "$2"; fi
}

# meter_fg <percent> <base-fg> → fg matched to the bg meter_bg picks:
# ink on the light clay amber, cream on the dark barn red, else the base fg.
meter_fg() {
  if   [ "$1" -ge 90 ] 2>/dev/null; then echo "$LIGHT_FG"   # barn red (dark) → cream
  elif [ "$1" -ge 70 ] 2>/dev/null; then echo "$DARK_FG"    # clay amber (light) → ink
  else echo "$2"; fi
}

# Battery ramp (Nerd Font FA, literal glyphs — bash 3.2 won't expand \u).
# Reads as budget REMAINING: full at low usage, empty when nearly spent.
I_BAT_4=$''   # nf-fa-battery_full           U+F240
I_BAT_3=$''   # nf-fa-battery_three_quarters U+F241
I_BAT_2=$''   # nf-fa-battery_half           U+F242
I_BAT_1=$''   # nf-fa-battery_quarter        U+F243
I_BAT_0=$''   # nf-fa-battery_empty          U+F244

# meter_icon <percent-used> → battery at the matching remaining level.
meter_icon() {
  if   [ "$1" -ge 90 ] 2>/dev/null; then printf '%s' "$I_BAT_0"
  elif [ "$1" -ge 70 ] 2>/dev/null; then printf '%s' "$I_BAT_1"
  elif [ "$1" -ge 50 ] 2>/dev/null; then printf '%s' "$I_BAT_2"
  elif [ "$1" -ge 25 ] 2>/dev/null; then printf '%s' "$I_BAT_3"
  else printf '%s' "$I_BAT_4"; fi
}

# meter_left <percent-used> → percent of the window still available.
meter_left() {
  local used="${1:-0}"
  [ "$used" -gt 100 ] 2>/dev/null && used=100
  [ "$used" -lt 0 ] 2>/dev/null && used=0
  echo "$((100 - used))"
}

# ── Git branch + dirty count (run in the reported cwd) ────────────────────────
branch=""; dirty=""
if git -C "$raw_cwd" rev-parse --git-dir >/dev/null 2>&1; then
  branch=$(git -C "$raw_cwd" symbolic-ref --short HEAD 2>/dev/null \
           || git -C "$raw_cwd" describe --tags --exact-match HEAD 2>/dev/null \
           || git -C "$raw_cwd" rev-parse --short HEAD 2>/dev/null)
  changed=$(git -C "$raw_cwd" --no-optional-locks status --porcelain 2>/dev/null | grep -c .)
  [ "${changed:-0}" -gt 0 ] && dirty=" ${SUBSEP} ${changed}*"
fi

# ── Usage (rate limits + session) via usage-hud --json ────────────────────────
I_SESS=$''   # clock         (oct-clock U+F43A)
I_WK=$''     # calendar      (fa-calendar_days U+F073)
I_RESET=$''  # refresh       (fa-refresh U+F021) — resets in
I_OPUS=$''   # crown         (fa-crown U+EDEB) — Opus weekly cap
I_TOK=$''    # coins         (fa-coins U+EDE8) — session tokens
I_COST=$'󰄔'   # cash  (md-cash U+F0114) — session cost
I_AGENT=$''  # robot         (fa-robot U+EE0D) — subagent calls
opus=""; opus_r=""; tokens=""; cost=""; agents=""
fiveh=""; fiveh_r=""; wk=""; wk_r=""; sess=""
usage_json=$(printf '%s' "$input" | node "$HOME/.claude/hud/usage-hud.mjs" --json 2>/dev/null)
if [ -n "$usage_json" ]; then
  eval "$(printf '%s' "$usage_json" | jq -r '
    "fiveh=\(.fiveHour // "")",
    "fiveh_r=\(.fiveHourReset // "")",
    "wk=\(.weekly // "")",
    "wk_r=\(.weeklyReset // "")",
    "opus=\(.opusWeekly // "")",
    "opus_r=\(.opusWeeklyReset // "")",
    "tokens=\(.sessionTokens // "")",
    "cost=\(.sessionCost // "" | ltrimstr("$"))",
    "agents=\(.agentCalls // 0)",
    "sess=\(if .sessionMin != null then (if .sessionMin >= 60 then "\(.sessionMin/60|floor)h\(.sessionMin%60)m" else "\(.sessionMin)m" end) else "" end)"
  ' 2>/dev/null)"
fi

# ── Single left-flowing segment list ─────────────────────────────────────────
# Identity group uses cool blues/greys; meter group uses distinct saturated hues.
texts=(); fgs=(); bgs=()
add_seg() { texts+=("$1"); fgs+=("$2"); bgs+=("$3"); }

# identity group
[ -n "$vim_mode" ] && add_seg " ${vim_mode} " "$DARK_FG" "$vim_bg"
[ -n "$branch" ] && add_seg " ${I_GIT} ${branch}${dirty} " "$BR_FG" "$BR_BG"
add_seg " ${I_DIR} ${dir_name} " "$DIR_FG" "$DIR_BG"
# meter group
# Session pops (ink on Claude orange); kraft-brown/sienna meters take cream;
# weekly stays recessive with a dim base fg. Amber/red states handled by meter_fg.
sess_txt=" ${I_SESS} ${sess}"
[ "${agents:-0}" -gt 0 ] 2>/dev/null && sess_txt="${sess_txt} ${SUBSEP} ${I_AGENT} ${agents}"
[ -n "$sess" ]   && add_seg "${sess_txt} " "$DARK_FG" "$SESS_BG"
[ -n "$fiveh" ]  && add_seg " $(meter_icon "$fiveh") $(meter_left "$fiveh")% ${SUBSEP} ${I_RESET} ${fiveh_r} " "$(meter_fg "$fiveh" "$DARK_FG")" "$(meter_bg "$fiveh" "$BASE_5H")"
[ -n "$wk" ]     && add_seg " ${I_WK} $(meter_icon "$wk") $(meter_left "$wk")% ${SUBSEP} ${I_RESET} ${wk_r} " "$(meter_fg "$wk" "$DARK_FG")" "$(meter_bg "$wk" "$BASE_WK")"
[ -n "$opus" ]   && add_seg " ${I_OPUS} $(meter_icon "$opus") $(meter_left "$opus")% ${SUBSEP} ${I_RESET} ${opus_r} " "$(meter_fg "$opus" "$LIGHT_FG")" "$(meter_bg "$opus" 131)"
add_seg " ${I_CTX} ${ctx}% " "$(meter_fg "$ctx" "$LIGHT_FG")" "$(meter_bg "$ctx" "$BASE_CTX")"
[ -n "$tokens" ] && add_seg " ${I_TOK} ${tokens} " "$DARK_FG" "$BASE_TOK"
[ -n "$cost" ]   && add_seg " ${I_COST} \$${cost} " "$DARK_FG" "$BASE_TOK"

# ── Render powerline ──────────────────────────────────────────────────────────
out=""
n=${#texts[@]}
for i in "${!texts[@]}"; do
  out+="$(bg "${bgs[$i]}")$(fg "${fgs[$i]}")${BOLD}${texts[$i]}${RESET}"
  if [ "$i" -lt "$((n - 1))" ]; then
    next_bg="${bgs[$((i+1))]}"
    if [ "$next_bg" = "${bgs[$i]}" ]; then
      out+="$(bg "$next_bg")$(fg "${fgs[$i]}")${SUBSEP}${RESET}"  # thin sep takes the block's own text colour
    else
      out+="$(fg "${bgs[$i]}")$(bg "$next_bg")${SEP}${RESET}"  # transition to next
    fi
  else
    out+="$(fg "${bgs[$i]}")$(bg $TAIL_BG)${SEP}${RESET}"      # tail cap
  fi
done

printf '%b\n' "$out"
