# claude-code-lualine

A powerline statusline for [Claude Code](https://claude.com/claude-code), in the style of nvim's lualine.

```
 vim-mode │  branch │  dir │ 🕐 12m │ 🔋 ▸ ↻ 3h09m │ 📅 🔋 ▸ ↻ 18h19m │ 🧠 53% │ 🪙 52.5k ▸ 💵 $42
```

Segments, left to right:

| Segment | Shows |
|---|---|
| vim mode | Only when `/vim` is on; colour tracks the mode |
| branch | Git branch + dirty-file count |
| dir | Current working directory |
| session | Duration of the current session |
| 5-hour limit | Battery icon for budget remaining + time until reset |
| weekly limit | Same, for the 7-day window |
| Opus weekly | Same, for the separate Opus cap — hidden unless your plan reports one |
| context | Percentage of the model's context window in use |
| session tokens | Total input + output tokens this session |
| session cost | List-price cost of this session's tokens |

An asterisk (`*`) after a battery means the usage poll failed and the percentages are from cache — most often the endpoint rate-limiting the poll. A failed poll backs off for 5 minutes (`CACHE_TTL_FAILURE_MS`) rather than retrying on every redraw.

The rate-limit meters read as **budget remaining**: the battery drains full → empty as you spend, and the block heats from its base colour through clay (≥70%) to barn red (≥90%).

## Requirements

- **A Nerd Font** in your terminal (the icons and powerline separators come from it). Built and tested against JetBrainsMono Nerd Font.
- **Node.js** 18+ and **jq**.
- macOS or Linux. Credential reading is implemented for the macOS Keychain and for `~/.claude/.credentials.json`.

## Install

```sh
git clone https://github.com/b1tweiser/claude-code-lualine.git ~/.claude/hud
```

Then point Claude Code at it in `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "bash $HOME/.claude/hud/lualine.sh"
  }
}
```

`lualine.sh` is the renderer; it shells out to `usage-hud.mjs --json` for the numbers. `usage-hud.mjs` also runs standalone as a plain-text statusline if you'd rather not use the powerline version.

## What it accesses

Worth knowing before you run it:

- It reads your Claude Code **OAuth token** from the macOS Keychain (`security find-generic-password`) or `~/.claude/.credentials.json`, and sends it as a bearer token to `https://api.anthropic.com/api/oauth/usage` to fetch your rate-limit percentages. That endpoint is what the Claude Code client itself uses; it is not part of the documented public API and may change.
- It reads your **session transcripts** under `~/.claude/projects/` to compute session duration, token totals, and cost.
- Everything stays local. Two cache files are written next to your config: `.hud-usage-cache.json` (rate limits, 90s TTL) and `.hud-session-cost.json` (per-session byte offset + running cost).

Nothing is uploaded anywhere except the single authenticated request to Anthropic's own usage endpoint.

## Cost accounting

`usage-hud.mjs` prices each turn from the transcript's `message.usage`, counting all four token classes separately — cache reads usually dominate the total, so anything that only sums input + output will read far too low.

The `PRICING` table near the top of `usage-hud.mjs` holds per-million-token list prices; cache writes are 1.25× input (5-minute TTL) or 2× (1-hour), and cache reads are 0.1×. Update the table when prices change.

**This is list price** — what the tokens would cost on the API. On a Claude subscription it is a usage signal, not a bill.

## Customizing

Everything worth changing is at the top of `lualine.sh`:

- **Colours** — `MODEL_BG`, `BR_BG`, `DIR_BG`, `SESS_BG`, `BASE_5H`, `BASE_WK`, `BASE_CTX`, `BASE_TOK`, plus `AMBER` / `HOT` for the warning states. All 256-colour indices.
- **Icons** — the `I_*` variables. Note they hold **literal glyph bytes**, not escapes: macOS ships bash 3.2, which does not expand `$'\uXXXX'`.
- **Thresholds** — `meter_bg`, `meter_fg`, and `meter_icon` all switch at 70% and 90%; `meter_icon` adds steps at 25% and 50%.

### Finding the right glyph

Nerd Font v3 remapped the Font Awesome range, so codepoints you remember (or find in old cheatsheets) are often wrong — you get tofu or a completely different icon. Read them out of the font you actually have:

```py
from fontTools.ttLib import TTFont
import os, re
cm = {}
for t in TTFont(os.path.expanduser("~/Library/Fonts/JetBrainsMonoNerdFont-Bold.ttf"))["cmap"].tables:
    cm.update(t.cmap)
for cp, name in sorted(cm.items()):
    if cp > 0xE000 and re.search(r"brain|battery|clock", name):
        print(f"{chr(cp)}  {hex(cp)}  {name}")
```

## Credits

`usage-hud.mjs` is based on [oh-my-claudecode](https://github.com/yeachan-heo/oh-my-claudecode) by Yeachan Heo (MIT). See [LICENSE](LICENSE).
