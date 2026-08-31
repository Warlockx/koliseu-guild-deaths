# koliseu-guild-deaths

Posts deaths of a [KoliseuOT](https://koliseuot.com.br) guild's members to a
Discord webhook, running entirely on GitHub Actions (no server, no
dependencies, no database). Currently watching **Grupo Anti Yoga** on world
**Season** (world 2).

## How it works

1. The workflow runs as a **self-dispatching chain**: each run polls the API
   several times (7 × 40s ≈ 5 min), commits state after every poll, then
   re-triggers the next run via `workflow_dispatch`. Effective gap between
   death checks is ~40-60s, sustained 24/7.
2. The cron is only a **watchdog**: GitHub's scheduler coalesces frequent crons
   (in practice `* * * * *` fires roughly every 10 minutes), so cron alone
   can't poll fast — the chain does. The watchdog fires at most every 5 min
   just to re-anchor the chain if it ever dies. Because every run (even a
   failed one) re-dispatches its successor, and push/pull races between
   overlapping runs are recovered by resetting to origin, the chain is
   self-healing; a cancelled or failed run costs at most one duplicate
   notification in a rare 1-2s window.
3. The script calls the same public tRPC endpoint the site's
   [Confronto de Guilds](https://koliseuot.com.br/community/guild-deaths) page
   uses:

   ```
   GET https://koliseuot.com.br/api/trpc/guildDeaths.board?batch=1&input={"0":{"worldId":2,"guildIds":[2],"from":<unix>,"to":<unix>,"pvpOnly":false,"tzOffsetMinutes":180}}
   ```

   Deaths come back in `result.data.world.recent` (newest first, capped at
   ~100 records) with fields `victimName, level, time, killedBy, killerName,
   mostDamageBy, mostDamageIsPlayer`. No authentication/cookie needed.
4. The guild's numeric id is resolved by name at runtime via
   `GET /api/community/guilds/<guild name>` (currently id **2**), so the guild
   being re-created with a new id is picked up automatically. The board's
   `summary[].name` is used as a safety check that the id still maps to the
   configured guild name.
5. New deaths are deduplicated against `state.json` (keyed by
   `victimName|time|level`, keys forgotten after 7 days) and sent to Discord as
   embeds in Portuguese, max 10 per message. The first-ever run seeds state
   silently so setup doesn't dump old deaths into the channel.
6. `state.json` is committed back to the repo after each poll — that file is
   the entire persistence layer.

## Setup

- Repo secret: `DISCORD_WEBHOOK_URL` = your Discord webhook URL.
  ```bash
  gh secret set DISCORD_WEBHOOK_URL --body "https://discord.com/api/webhooks/..."
  ```
- That's it. Trigger manually with `gh workflow run notify-deaths.yml`.

### Local run

```bash
DISCORD_WEBHOOK_URL="https://..." node notify-deaths.mjs --test  # send a test embed
DRY_RUN=1 node notify-deaths.mjs                                 # poll without sending
```

## Configuration (`config.json`)

| key                   | meaning                                                        |
| --------------------- | -------------------------------------------------------------- |
| `guildName`           | guild to watch, resolved to an id at runtime                   |
| `guildId`             | fallback id if the resolve call fails (currently 2)             |
| `worldId`             | 2 = Season, 1 = Legacy                                          |
| `lookbackHours`       | size of the fetch window (12h ≈ ~60 deaths for this guild)      |
| `tzOffsetMinutes`     | passed to the API like the site does (180 = America/Sao_Paulo)  |
| `pollIntervalSeconds` | sleep between the in-run polls                                  |
| `pollsPerRun`         | polls per run (7 × 40s ≈ 5 min, then the run re-dispatches itself) |

## Caveats

- **The repo must stay public**: this polling cadence is only free on public
  repos; on private repos the every-minute cron would exceed the free Actions
  minutes quickly.
- **GitHub disables scheduled workflows after 60 days without repo activity**,
  and commits pushed by `GITHUB_TOKEN` may not count as activity. If
  notifications stop, run `gh workflow run notify-deaths.yml` or push any
  commit to re-enable the schedule.
- The webhook URL in this repo's secret was shared in plaintext during setup —
  regenerate it in Discord and update the secret.
