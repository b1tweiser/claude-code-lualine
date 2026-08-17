#!/usr/bin/env bash
# Flip the statusline between compact and expanded (reset countdowns + cost).
f="$HOME/.claude/.hud-expanded"
if [ -f "$f" ]; then rm -f "$f"; echo "hud: folded"; else : > "$f"; echo "hud: expanded"; fi
