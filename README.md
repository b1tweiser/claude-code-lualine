# claude-code-lualine

A powerline statusline for [Claude Code](https://claude.com/claude-code), in the style of nvim's lualine.

![The statusline in a terminal](assets/statusline.png)

The leftmost `INSERT` block only appears if you use Claude Code's vim mode; without it the bar starts at the directory.


Segments, left to right:

| Segment | Shows |
|---|---|
| vim mode | Only when `/vim` is on; colour tracks the mode |
| branch | Git branch + dirty-file count |
| dir | Current working directory |
| session | Duration of the current session |
| 5-hour limit | Battery icon + percent of the window still left, and time until reset |
| weekly limit | Same, for the 7-day window — expanded only |
| Opus weekly | Same, for the separate Opus cap — expanded only, and hidden unless your plan reports one |
| context | Percentage of the model's context window in use |
| session tokens | Total input + output tokens this session — expanded only |
| session cost | List-price cost of this session's tokens — expanded only |
| agents | Subagents in flight — `Task`/`Agent` calls with no result back yet. Tail of the line, shown only while at least one is running |

Rate-limit numbers are polled every 2 minutes (`CACHE_TTL_MS`) and served from cache in between; a failed poll backs off for 5 minutes (`CACHE_TTL_FAILURE_MS`) rather than retrying on every redraw. The endpoint 429s readily — 30s polling trips it immediately and even 60s draws rejections — and every rejection costs 5 minutes of frozen numbers, so raise those values rather than lowering them. Set `CLAUDE_HUD_DUMP=/path/to/file.json` to capture the raw endpoint payload on the next successful poll if you want to inspect fields the renderer does not use. `usage-hud.mjs --json` still reports a `stale` flag if you want to surface cached-data state somehow — the powerline renderer deliberately ignores it. If a poll fails with no cache to fall back on (first run, signed out), the meter blocks render as `--%` rather than disappearing.

The rate-limit meters read as **budget remaining** — the number counts down from 100% as you spend, the battery drains full → empty alongside it, and the block heats from its base colour through clay (at 30% left) to barn red (at 10% left).

## Folded and expanded

Two densities. **Folded** — the default — keeps branch, dir, session, the 5-hour meter with its reset time, and context. **Expanded** adds the weekly meter, the Opus cap, session tokens, and cost.

`hud-toggle.sh` flips between them by creating or removing `~/.claude/.hud-expanded`. The next redraw picks it up; nothing to restart.

```sh
~/.claude/hud/hud-toggle.sh   # prints "hud: expanded" or "hud: folded"
```

Worth a one-word command in your shell config:

```sh
# zsh / bash — ~/.zshrc
fold() { ~/.claude/hud/hud-toggle.sh; }
```

```nu
# nushell — $nu.config-path
def fold [] { ^($env.HOME | path join ".claude/hud/hud-toggle.sh") }
```

`fold` shadows `/usr/bin/fold`, the text-wrapping utility — pick another name if you use it. Inside Claude Code, `!` runs a snapshot of your login shell taken when the session started — `! fold` works in sessions opened after you add the function, and in older ones you can still call `! ~/.claude/hud/hud-toggle.sh`. Note nushell users get the same `!` shell as everyone else (zsh/bash), not nu, so the nu `def` alone won't answer there.

## Install

### 1. Prerequisites

**A Nerd Font**, set as your terminal font. The powerline separators and every icon come from it — without one you get tofu boxes.

```sh
# macOS
brew install --cask font-jetbrains-mono-nerd-font

# Linux
mkdir -p ~/.local/share/fonts && cd ~/.local/share/fonts
curl -fLO https://github.com/ryanoasis/nerd-fonts/releases/latest/download/JetBrainsMono.zip
unzip -o JetBrainsMono.zip && fc-cache -f
```

Then set the font in your terminal's settings (iTerm2: Settings → Profiles → Text → Font; Ghostty: `font-family = "JetBrainsMono Nerd Font"`; VS Code: `"terminal.integrated.fontFamily": "JetBrainsMono Nerd Font"`).

**`jq` and Node.js 18+:**

```sh
# macOS
brew install jq node

# Debian/Ubuntu
sudo apt install jq nodejs
```

Verify all three before continuing — the last line should print a folder icon, not a box:

```sh
jq --version && node --version && printf '\uf07b\n'
```

### 2. Get the files

```sh
git clone https://github.com/b1tweiser/claude-code-lualine.git ~/.claude/hud
```

Any location works; just match the path in step 3.

### 3. Point Claude Code at it

Add to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "bash $HOME/.claude/hud/lualine.sh"
  }
}
```

If the file already exists, add the `statusLine` key alongside what's there rather than replacing the file. Any existing `statusLine` config is superseded.

### 4. Check it

```sh
echo '{"cwd":"'"$PWD"'","model":{"display_name":"Opus 5"},"context_window":{"used_percentage":42}}' \
  | bash ~/.claude/hud/lualine.sh
```

You should get a colored bar. Then start Claude Code — the statusline appears at the bottom. Rate-limit meters may show `--%` on the very first render, until the first successful poll.

### Troubleshooting

| Symptom | Cause |
|---|---|
| Boxes or blank squares instead of icons | Terminal isn't using a Nerd Font, or is falling back for bold text |
| Nothing appears at all | `jq` or `node` missing, or a wrong path in `settings.json` — run the step 4 command to see the error |
| Meters stuck at `--%` | No credentials found, or the usage endpoint is rejecting polls. Confirm you're signed in with `claude` |
| Percentages don't move | Normal — usage is polled every 2 minutes, and a rejected poll backs off for 5 |
| Cost shows `$0.00` | Session has no priced turns yet, or the model isn't in the `PRICING` table |

### Uninstall

Remove the `statusLine` block from `~/.claude/settings.json`, then `rm -rf ~/.claude/hud` and `rm -f ~/.claude/.hud-usage-cache.json ~/.claude/.hud-session-cost.json`.

## Notes

- **Vim mode is not required.** The leftmost mode block only renders if you've enabled vim mode in Claude Code with `/vim`; otherwise the bar simply starts at the git branch. Installing this does not change your editing mode.
- `lualine.sh` is the renderer; it shells out to `usage-hud.mjs --json` for the numbers. `usage-hud.mjs` also runs standalone as a plain-text statusline if you'd rather not use the powerline version.
- Credential reading is implemented for the macOS Keychain and for `~/.claude/.credentials.json`.

## What it accesses

Worth knowing before you run it:

- It reads your Claude Code **OAuth token** from the macOS Keychain (`security find-generic-password`) or `~/.claude/.credentials.json`, and sends it as a bearer token to `https://api.anthropic.com/api/oauth/usage` to fetch your rate-limit percentages. That endpoint is what the Claude Code client itself uses; it is not part of the documented public API and may change.
- It reads your **session transcripts** under `~/.claude/projects/` to compute session duration, token totals, and cost.
- Everything stays local. Two cache files are written next to your config: `.hud-usage-cache.json` (rate limits, 2min TTL) and `.hud-session-cost.json` (per-session byte offset + running cost).

Nothing is uploaded anywhere except the single authenticated request to Anthropic's own usage endpoint.

## Cost accounting

`usage-hud.mjs` prices each turn from the transcript's `message.usage`, counting all four token classes separately — cache reads usually dominate the total, so anything that only sums input + output will read far too low.

The `PRICING` table near the top of `usage-hud.mjs` holds per-million-token list prices; cache writes are 1.25× input (5-minute TTL) or 2× (1-hour), and cache reads are 0.1×. Update the table when prices change.

**This is list price** — what the tokens would cost on the API. On a Claude subscription it is a usage signal, not a bill.

## Customizing

Everything worth changing is at the top of `lualine.sh`:

- **Colours** — `BR_BG`, `DIR_BG`, `SESS_BG`, `AGENT_BG`, `BASE_5H`, `BASE_WK`, `BASE_CTX`, `BASE_TOK`, plus `AMBER` / `HOT` for the warning states. All 256-colour indices.
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
