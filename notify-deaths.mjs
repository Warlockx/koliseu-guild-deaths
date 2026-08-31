#!/usr/bin/env node
/**
 * koliseu-guild-deaths — watches koliseuot.com.br guild deaths and posts new
 * deaths of the configured guild's members to a Discord webhook.
 *
 * Usage:
 *   node notify-deaths.mjs           normal poll (one check per invocation)
 *   node notify-deaths.mjs --test    send a test embed to the webhook, no state change
 *
 * Environment:
 *   DISCORD_WEBHOOK_URL  required (unless DRY_RUN) — Discord webhook URL
 *   DRY_RUN=1            print payloads instead of sending them
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(readFileSync(join(HERE, "config.json"), "utf8"));
const STATE_PATH = join(HERE, "state.json");
const SEEN_TTL_SECONDS = 7 * 24 * 60 * 60; // forget deaths older than 7 days

const API_BASE = "https://koliseuot.com.br";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 koliseu-guild-deaths/1.0";
const DRY_RUN = process.env.DRY_RUN === "1";
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const TEST_MODE = process.argv.includes("--test");

const log = (...args) => console.log(new Date().toISOString(), ...args);

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

/** Resolve the guild's numeric id by name; falls back to config.guildId. */
async function resolveGuildId() {
  try {
    const data = await fetchJson(
      `${API_BASE}/api/community/guilds/${encodeURIComponent(CONFIG.guildName)}`,
    );
    const guild = data?.args?.data;
    if (guild && typeof guild.id === "number") {
      if (guild.worldId !== CONFIG.worldId) {
        log(`WARN: guild "${guild.name}" worldId=${guild.worldId}, expected ${CONFIG.worldId}`);
      }
      return guild.id;
    }
    log(`WARN: guild resolve returned unexpected shape, falling back to guildId=${CONFIG.guildId}`);
  } catch (err) {
    log(`WARN: guild resolve failed (${err.message}), falling back to guildId=${CONFIG.guildId}`);
  }
  return CONFIG.guildId;
}

/** Fetch recent deaths of the guild from guildDeaths.board. */
async function fetchGuildDeaths(guildId) {
  const to = Math.floor(Date.now() / 1000);
  const from = to - CONFIG.lookbackHours * 3600;
  const input = JSON.stringify({
    "0": {
      worldId: CONFIG.worldId,
      guildIds: [guildId],
      from,
      to,
      pvpOnly: false,
      tzOffsetMinutes: CONFIG.tzOffsetMinutes,
    },
  });
  const url = `${API_BASE}/api/trpc/guildDeaths.board?batch=1&input=${encodeURIComponent(input)}`;
  const json = await fetchJson(url);
  // response is [{result:{data:{world, summary, recent, ...}}}]; some
  // deployments wrap the payload in superjson's .json instead
  const raw = json?.[0]?.result?.data;
  const board = Array.isArray(raw?.recent) ? raw : raw?.json;
  if (!board) throw new Error(`unexpected guildDeaths.board response: ${JSON.stringify(json).slice(0, 500)}`);

  const summary = Array.isArray(board.summary) ? board.summary : [];
  const self = summary.find((s) => s.guildId === guildId);
  if (self && self.name && self.name !== CONFIG.guildName) {
    throw new Error(`guild id ${guildId} resolves to "${self.name}", expected "${CONFIG.guildName}" — refusing to notify`);
  }
  log(`board ok: guild="${self?.name ?? "?"}" members=${self?.members ?? "?"} deaths(window)=${self?.deaths ?? "?"} recent=${board.recent?.length ?? 0}`);

  const recent = Array.isArray(board.recent) ? board.recent : [];
  return recent
    .filter((d) => d.guildId === guildId && d.victimName && typeof d.time === "number")
    .sort((a, b) => a.time - b.time); // oldest first, so notifications read chronologically
}

function loadState() {
  if (!existsSync(STATE_PATH)) return null;
  try {
    const state = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    return state && typeof state.seen === "object" && state.seen !== null ? state : null;
  } catch {
    return null;
  }
}

function saveState(state, extraSeen = []) {
  const now = Math.floor(Date.now() / 1000);
  for (const [key, deathTime] of extraSeen) state.seen[key] = deathTime;
  const cutoff = now - SEEN_TTL_SECONDS;
  for (const [key, deathTime] of Object.entries(state.seen)) {
    if (deathTime < cutoff) delete state.seen[key];
  }
  state.lastRunAt = now;
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

function deathKey(d) {
  return `${d.victimName}|${d.time}|${d.level}`;
}

function buildEmbed(d) {
  const pvpKill = d.killerName != null || d.mostDamageIsPlayer === true;
  const lines = [];
  if (d.killedBy) {
    lines.push(`Morto por: **${d.killedBy}**${d.killerName != null ? " 🗡️" : " 👹"}`);
  }
  if (d.mostDamageBy && d.mostDamageBy !== d.killedBy) {
    lines.push(`Maior dano: **${d.mostDamageBy}**${d.mostDamageIsPlayer ? " 🗡️" : " 👹"}`);
  }
  lines.push(`Quando: <t:${d.time}:F> (<t:${d.time}:R>)`);
  return {
    title: `💀 ${d.victimName} morreu (nível ${d.level})`,
    url: `${API_BASE}/community/character/${encodeURIComponent(d.victimName)}`,
    description: lines.join("\n"),
    color: pvpKill ? 0xe74c3c : 0x95a5a6,
    timestamp: new Date(d.time * 1000).toISOString(),
    footer: { text: `${CONFIG.guildName} · mundo ${CONFIG.worldId === 2 ? "Season" : "Legacy"}` },
  };
}

async function postWebhook(payload) {
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 429) {
    const retryMs = (Number((await res.json().catch(() => ({}))).retry_after) || 2) * 1000;
    log(`rate limited, retrying in ${retryMs}ms`);
    await new Promise((r) => setTimeout(r, retryMs));
    return postWebhook(payload);
  }
  if (!res.ok) throw new Error(`webhook POST -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

/**
 * Send deaths in batches of 10 embeds. Records each successfully sent batch
 * into state immediately, so a failure mid-way never re-sends those deaths.
 */
async function sendDeaths(deaths, state) {
  const remember = (batch) => saveState(state, batch.map((d) => [deathKey(d), d.time]));
  for (let i = 0; i < deaths.length; i += 10) {
    const batch = deaths.slice(i, i + 10);
    const payload = { embeds: batch.map(buildEmbed) };
    if (DRY_RUN) {
      log(`DRY_RUN: would send ${batch.length} embed(s):`, JSON.stringify(payload, null, 2));
      remember(batch);
      continue;
    }
    await postWebhook(payload);
    log(`sent ${batch.length} embed(s) to Discord`);
    remember(batch);
  }
}

async function main() {
  if (!DRY_RUN && !WEBHOOK_URL) throw new Error("DISCORD_WEBHOOK_URL is not set");
  if (DRY_RUN) log("DRY_RUN active — nothing will be sent");

  if (TEST_MODE) {
    const embed = {
      title: "🧪 Teste de webhook",
      description: "Se você está vendo isto, o notificador de mortes do Koliseu está funcionando.",
      color: 0x2ecc71,
      footer: { text: `${CONFIG.guildName} · mundo ${CONFIG.worldId === 2 ? "Season" : "Legacy"}` },
    };
    if (DRY_RUN) log("DRY_RUN: test embed:", JSON.stringify(embed));
    else await postWebhook({ embeds: [embed] });
    log("test done");
    return;
  }

  const guildId = await resolveGuildId();
  const deaths = await fetchGuildDeaths(guildId);
  const state = loadState();

  // First ever run: seed state silently so setup doesn't dump the whole
  // lookback window of old deaths into Discord.
  if (!state) {
    saveState({ seen: Object.fromEntries(deaths.map((d) => [deathKey(d), d.time])) });
    log(`first run: seeded state with ${deaths.length} existing death(s), none notified`);
    return;
  }

  const fresh = deaths.filter((d) => !(deathKey(d) in state.seen));
  log(`poll: ${deaths.length} in window, ${fresh.length} new`);
  saveState(state); // refresh lastRunAt + prune old keys even when nothing is new
  if (fresh.length > 0) await sendDeaths(fresh, state);
}

main().catch((err) => {
  console.error(new Date().toISOString(), "FATAL:", err?.stack ?? err);
  process.exit(1);
});
