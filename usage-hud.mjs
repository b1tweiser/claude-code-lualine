#!/usr/bin/env node
/**
 * Lightweight Claude Code Status HUD
 *
 * Based on oh-my-claudecode (MIT License)
 * https://github.com/yeachan-heo/oh-my-claudecode
 *
 * Standalone statusline showing: rate limits, context %, session duration, token usage.
 * No external dependencies — reads Claude Code stdin JSON + OAuth credentials directly.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, createReadStream, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { execSync } from 'node:child_process';
import https from 'node:https';

// ============================================================================
// ANSI Colors
// ============================================================================
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

// ============================================================================
// Config
// ============================================================================
const CACHE_TTL_MS = 60_000; // 60s between API polls; a 429 falls back to CACHE_TTL_FAILURE_MS
const CACHE_TTL_FAILURE_MS = 300_000; // back off 5min after a failed poll (the endpoint 429s easily)
const API_TIMEOUT_MS = 10_000;
const MAX_TAIL_BYTES = 512 * 1024;
const WARNING_THRESHOLD = 70;
const CRITICAL_THRESHOLD = 90;

function getClaudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

function getCachePath() {
  return join(getClaudeConfigDir(), '.hud-usage-cache.json');
}

// ============================================================================
// Stdin Parser
// ============================================================================
async function readStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = chunks.join('');
  if (!raw.trim()) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function getContextPercent(stdin) {
  const pct = stdin?.context_window?.used_percentage;
  if (typeof pct === 'number' && !Number.isNaN(pct)) {
    return Math.min(100, Math.max(0, Math.round(pct)));
  }
  const size = stdin?.context_window?.context_window_size;
  if (!size || size <= 0) return 0;
  const usage = stdin?.context_window?.current_usage;
  const total = (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0);
  return Math.min(100, Math.round((total / size) * 100));
}

function getModelName(stdin) {
  const displayName = stdin?.model?.display_name ?? '';
  const id = (stdin?.model?.id ?? '').toLowerCase();
  const haystack = `${id} ${displayName.toLowerCase()}`;

  let family = null;
  if (haystack.includes('opus')) family = 'Opus';
  else if (haystack.includes('sonnet')) family = 'Sonnet';
  else if (haystack.includes('haiku')) family = 'Haiku';

  if (!family) {
    return displayName || id.split('-').slice(0, 3).join('-') || 'Unknown';
  }

  // Extract version like "4-7" / "4.7" → "4.7"
  const versionMatch = id.match(/(\d+)[-.](\d+)/) || displayName.match(/(\d+)[-.](\d+)/);
  if (versionMatch) return `${family}${versionMatch[1]}.${versionMatch[2]}`;

  return family;
}

// ============================================================================
// Transcript Parser (token usage + session start)
// ============================================================================
async function parseTranscript(transcriptPath) {
  const result = { sessionStart: null, lastTokenUsage: null, sessionTotalTokens: 0, toolCallCount: 0, agentCallCount: 0 };
  if (!transcriptPath || !existsSync(transcriptPath)) return result;

  const lines = [];
  try {
    const stat = statSync(transcriptPath);
    if (stat.size > MAX_TAIL_BYTES) {
      // Tail-read
      const startOffset = Math.max(0, stat.size - MAX_TAIL_BYTES);
      const bytesToRead = stat.size - startOffset;
      const fd = openSync(transcriptPath, 'r');
      const buffer = Buffer.alloc(bytesToRead);
      try { readSync(fd, buffer, 0, bytesToRead, startOffset); } finally { closeSync(fd); }
      const content = buffer.toString('utf8');
      const splitLines = content.split('\n');
      if (startOffset > 0) splitLines.shift();
      lines.push(...splitLines);
    } else {
      const fileStream = createReadStream(transcriptPath);
      const rl = createInterface({ input: fileStream, crlfDelay: Infinity });
      for await (const line of rl) lines.push(line);
    }
  } catch { return result; }

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (!result.sessionStart && entry.timestamp) {
        result.sessionStart = new Date(entry.timestamp);
      }
      // Token usage
      const usage = entry.message?.usage;
      if (usage) {
        const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
        const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
        const reasoning = usage.reasoning_tokens
          ?? usage.output_tokens_details?.reasoning_tokens
          ?? usage.completion_tokens_details?.reasoning_tokens
          ?? 0;
        result.lastTokenUsage = { input, output, reasoning: reasoning || 0 };
        result.sessionTotalTokens += input + output;
      }
      // Tool/agent counts
      const content = entry.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use') {
            result.toolCallCount++;
            if (block.name === 'Task' || block.name === 'proxy_Task' || block.name === 'Agent') {
              result.agentCallCount++;
            }
          }
        }
      }
    } catch { /* skip */ }
  }
  return result;
}

// ============================================================================
// OAuth Credentials
// ============================================================================
function getKeychainServiceName() {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (configDir) {
    const hash = createHash('sha256').update(configDir).digest('hex').slice(0, 8);
    return `Claude Code-credentials-${hash}`;
  }
  return 'Claude Code-credentials';
}

function readKeychainCredentials() {
  if (process.platform !== 'darwin') return null;
  const serviceName = getKeychainServiceName();
  // The same service can have multiple entries under different accounts:
  // newer claude-code uses "claude-code-user", older versions used the OS username,
  // and stale entries from prior logins may coexist. Read all candidates and pick
  // the one with the furthest expiresAt to avoid sticking to a stale token.
  const accounts = ['claude-code-user'];
  try { const u = userInfo().username?.trim(); if (u) accounts.push(u); } catch {}
  accounts.push(undefined);

  let best = null;
  for (const account of accounts) {
    try {
      const accountArg = account ? ` -a "${account}"` : '';
      const raw = execSync(
        `/usr/bin/security find-generic-password -s "${serviceName}"${accountArg} -w 2>/dev/null`,
        { encoding: 'utf-8', timeout: 2000 }
      ).trim();
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const creds = parsed.claudeAiOauth || parsed;
      if (!creds.accessToken) continue;
      const candidate = {
        accessToken: creds.accessToken,
        expiresAt: creds.expiresAt,
        refreshToken: creds.refreshToken,
      };
      if (!best || (candidate.expiresAt || 0) > (best.expiresAt || 0)) {
        best = candidate;
      }
    } catch { continue; }
  }
  return best;
}

function readFileCredentials() {
  try {
    const credPath = join(getClaudeConfigDir(), '.credentials.json');
    if (!existsSync(credPath)) return null;
    const parsed = JSON.parse(readFileSync(credPath, 'utf-8'));
    const creds = parsed.claudeAiOauth || parsed;
    if (creds.accessToken) return { accessToken: creds.accessToken, expiresAt: creds.expiresAt, refreshToken: creds.refreshToken };
  } catch {}
  return null;
}

function getCredentials() {
  return readKeychainCredentials() || readFileCredentials();
}

// ============================================================================
// Usage API
// ============================================================================
function fetchUsage(accessToken) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/api/oauth/usage',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      },
      timeout: API_TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        } else { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function readCache() {
  try {
    const path = getCachePath();
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch { return null; }
}

function writeCache(data) {
  try {
    const path = getCachePath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify({ timestamp: Date.now(), data }));
  } catch {}
}

// ============================================================================
// Session Spend (list price of this session's token usage)
// ============================================================================
// USD per million tokens. cw5m/cw1h are the two cache-write TTL rates
// (1.25x and 2x input); read is the cache-read rate (0.1x input).
const PRICING = {
  'claude-opus-5':     { in: 5, out: 25, cw5m: 6.25, cw1h: 10, read: 0.5 },
  'claude-opus-4-8':   { in: 5, out: 25, cw5m: 6.25, cw1h: 10, read: 0.5 },
  'claude-opus-4-7':   { in: 5, out: 25, cw5m: 6.25, cw1h: 10, read: 0.5 },
  'claude-fable-5':    { in: 10, out: 50, cw5m: 12.5, cw1h: 20, read: 1.0 },
  // Sonnet 5 intro pricing ($2/$10) runs through 2026-08-31.
  'claude-sonnet-5':   { in: 2, out: 10, cw5m: 2.5, cw1h: 4, read: 0.2 },
  'claude-sonnet-4-6': { in: 3, out: 15, cw5m: 3.75, cw1h: 6, read: 0.3 },
  'claude-haiku-4-5':  { in: 1, out: 5, cw5m: 1.25, cw1h: 2, read: 0.1 },
};

function priceFor(model) {
  if (!model) return null;
  if (PRICING[model]) return PRICING[model];
  for (const [id, p] of Object.entries(PRICING)) {
    if (model.startsWith(id)) return p;
  }
  return null;
}

function entryCost(entry) {
  const usage = entry.message?.usage;
  const price = priceFor(entry.message?.model);
  if (!usage || !price) return 0;
  const cc = usage.cache_creation ?? {};
  const w5 = cc.ephemeral_5m_input_tokens ?? usage.cache_creation_input_tokens ?? 0;
  const w1h = cc.ephemeral_1h_input_tokens ?? 0;
  return (
    (usage.input_tokens ?? 0) * price.in +
    (usage.output_tokens ?? 0) * price.out +
    w5 * price.cw5m +
    w1h * price.cw1h +
    (usage.cache_read_input_tokens ?? 0) * price.read
  ) / 1_000_000;
}

function getSessionCostPath() {
  return join(getClaudeConfigDir(), '.hud-session-cost.json');
}

// Sums the list-price cost of every priced turn in this session's transcript.
// Transcripts are append-only, so the file is re-read only from the byte offset
// last seen — a full parse happens once per session, not once per render.
function computeSessionSpend(transcriptPath) {
  if (!transcriptPath) return 0;
  let size;
  try { size = statSync(transcriptPath).size; } catch { return 0; }

  let prev = null;
  let all = {};
  try {
    all = JSON.parse(readFileSync(getSessionCostPath(), 'utf-8'));
    prev = all[transcriptPath];
  } catch {}
  if (prev && prev.offset === size) return prev.cost;

  // Truncated or rotated file: start over rather than trusting the offset.
  const start = prev && prev.offset < size ? prev.offset : 0;
  let cost = start > 0 ? prev.cost : 0;
  let offset = start;
  try {
    const fd = openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(size - start);
    try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
    const text = buf.toString('utf8');
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline >= 0) {
      offset = start + Buffer.byteLength(text.slice(0, lastNewline + 1));
      for (const line of text.slice(0, lastNewline).split('\n')) {
        if (!line.trim()) continue;
        try { cost += entryCost(JSON.parse(line)); } catch {}
      }
    }
  } catch { return cost; }

  // Keep only the sessions still on disk so the cache does not grow forever.
  const next = { [transcriptPath]: { offset, cost } };
  for (const [path, entry] of Object.entries(all)) {
    if (path !== transcriptPath && existsSync(path)) next[path] = entry;
  }
  try { writeFileSync(getSessionCostPath(), JSON.stringify(next)); } catch {}
  return cost;
}

async function getUsageData() {
  const cache = readCache();
  if (cache && Date.now() - cache.timestamp < CACHE_TTL_MS) {
    return cache.data;
  }
  // A failed poll (429, network drop) backs off instead of re-firing on every
  // render — the statusline redraws far more often than the endpoint tolerates.
  if (cache?.data && cache.failedAt && Date.now() - cache.failedAt < CACHE_TTL_FAILURE_MS) {
    return { ...cache.data, _stale: true };
  }

  const creds = getCredentials();
  if (!creds || !creds.accessToken) return cache?.data || null;
  if (creds.expiresAt && creds.expiresAt <= Date.now()) return cache?.data || null;

  const response = await fetchUsage(creds.accessToken);
  if (!response) {
    // Serve the stale cache, and remember the failure so we back off.
    if (cache?.data) {
      try {
        writeFileSync(getCachePath(), JSON.stringify({
          timestamp: cache.timestamp, data: cache.data, failedAt: Date.now(),
        }));
      } catch {}
      return { ...cache.data, _stale: true };
    }
    return null;
  }

  const fiveHour = response.five_hour?.utilization;
  const sevenDay = response.seven_day?.utilization;
  if (fiveHour == null && sevenDay == null) return null;

  const clamp = (v) => v == null || !isFinite(v) ? 0 : Math.max(0, Math.min(100, v));
  const parseDate = (s) => { if (!s) return null; const d = new Date(s); return isNaN(d.getTime()) ? null : d.toISOString(); };

  const data = {
    fiveHourPercent: clamp(fiveHour),
    weeklyPercent: sevenDay != null ? clamp(sevenDay) : undefined,
    fiveHourResetsAt: parseDate(response.five_hour?.resets_at),
    weeklyResetsAt: parseDate(response.seven_day?.resets_at),
  };

  // Per-model quotas
  if (response.seven_day_sonnet?.utilization != null) {
    data.sonnetWeeklyPercent = clamp(response.seven_day_sonnet.utilization);
    data.sonnetWeeklyResetsAt = parseDate(response.seven_day_sonnet.resets_at);
  }
  if (response.seven_day_opus?.utilization != null) {
    data.opusWeeklyPercent = clamp(response.seven_day_opus.utilization);
    data.opusWeeklyResetsAt = parseDate(response.seven_day_opus.resets_at);
  }

  writeCache(data);
  return data;
}

// ============================================================================
// Rendering
// ============================================================================
function getColor(percent) {
  if (percent >= CRITICAL_THRESHOLD) return RED;
  if (percent >= WARNING_THRESHOLD) return YELLOW;
  return GREEN;
}

function formatResetTime(isoStr) {
  if (!isoStr) return null;
  const diffMs = new Date(isoStr).getTime() - Date.now();
  if (diffMs <= 0) return null;
  const mins = Math.floor(diffMs / 60000);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  if (days > 0) return `${days}d${hrs % 24}h`;
  return `${hrs}h${mins % 60}m`;
}

function formatTokenCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function renderRateLimits(limits) {
  if (!limits) return null;
  const staleMarker = limits._stale ? `${DIM}*${RESET}` : '';

  const fh = Math.round(limits.fiveHourPercent);
  const fhColor = getColor(fh);
  const fhReset = formatResetTime(limits.fiveHourResetsAt);
  let out = `5hr:${fhColor}${fh}%${RESET}${staleMarker}`;
  if (fhReset) out += `(${fhReset})`;

  if (limits.weeklyPercent != null) {
    const wk = Math.round(limits.weeklyPercent);
    const wkColor = getColor(wk);
    const wkReset = formatResetTime(limits.weeklyResetsAt);
    out += ` week:${wkColor}${wk}%${RESET}${staleMarker}`;
    if (wkReset) out += `(${wkReset})`;
  }

  return out;
}

function renderTokenUsage(usage, sessionTotal) {
  if (!usage) return null;
  if (usage.input <= 0 && usage.output <= 0) return null;
  let out = `tok:i${formatTokenCount(usage.input)}/o${formatTokenCount(usage.output)}`;
  if (usage.reasoning > 0) out += `/r${formatTokenCount(usage.reasoning)}`;
  if (sessionTotal > 0) out += ` s${formatTokenCount(sessionTotal)}`;
  return out;
}

function renderSessionDuration(startDate) {
  if (!startDate) return null;
  const mins = Math.floor((Date.now() - startDate.getTime()) / 60000);
  if (mins < 1) return 'session:<1m';
  if (mins >= 60) return `session:${Math.floor(mins / 60)}h${mins % 60}m`;
  return `session:${mins}m`;
}

function renderContext(percent) {
  if (percent <= 0) return null;
  const color = percent >= 85 ? RED : percent >= 60 ? YELLOW : GREEN;
  return `ctx:${color}${percent}%${RESET}`;
}

// ============================================================================
// Main
// ============================================================================
async function main() {
  try {
    const stdin = await readStdin();
    if (!stdin) {
      console.log(`${DIM}[HUD] no stdin${RESET}`);
      return;
    }

    const contextPercent = getContextPercent(stdin);
    const modelName = getModelName(stdin);
    const transcript = await parseTranscript(stdin.transcript_path);
    const usage = await getUsageData();

    // Machine-readable mode for external renderers (e.g. lualine.sh).
    if (process.argv.includes('--json')) {
      const start = transcript.sessionStart ? new Date(transcript.sessionStart) : null;
      const sessionMin = start ? Math.floor((Date.now() - start.getTime()) / 60000) : null;
      console.log(JSON.stringify({
        fiveHour: usage && usage.fiveHourPercent != null ? Math.round(usage.fiveHourPercent) : null,
        fiveHourReset: usage ? formatResetTime(usage.fiveHourResetsAt) : '',
        weekly: usage && usage.weeklyPercent != null ? Math.round(usage.weeklyPercent) : null,
        weeklyReset: usage ? formatResetTime(usage.weeklyResetsAt) : '',
        opusWeekly: usage && usage.opusWeeklyPercent != null ? Math.round(usage.opusWeeklyPercent) : null,
        opusWeeklyReset: usage ? formatResetTime(usage.opusWeeklyResetsAt) : '',
        stale: !!(usage && usage._stale),
        sessionMin,
        sessionTokens: transcript.sessionTotalTokens > 0 ? formatTokenCount(transcript.sessionTotalTokens) : '',
        sessionCost: (() => { const c = computeSessionSpend(stdin.transcript_path); return c > 0 ? `$${c < 10 ? c.toFixed(2) : Math.round(c)}` : ''; })(),
        agentCalls: transcript.agentCallCount,
      }));
      return;
    }

    const parts = [];

    // Rate limits
    const rateLimits = renderRateLimits(usage);
    if (rateLimits) parts.push(rateLimits);

    // Context %
    const ctx = renderContext(contextPercent);
    if (ctx) parts.push(ctx);

    // Session duration
    const session = renderSessionDuration(transcript.sessionStart);
    if (session) parts.push(session);

    // Model
    if (modelName) parts.push(`model:${modelName}`);

    const separator = ` ${DIM}|${RESET} `;
    let output = parts.join(separator);

    // Context warning banner
    if (contextPercent >= 80) {
      output += `\n${RED}${BOLD}!! ctx ${contextPercent}% — consider /compact !!${RESET}`;
    }

    console.log(output);
  } catch (error) {
    console.log(`${DIM}[HUD] error${RESET}`);
    if (process.env.HUD_DEBUG) console.error(error);
  }
}

main();
