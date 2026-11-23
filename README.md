# Keep Talking

Five-minute daily practice for everyday conversation and sentence building, starting with Thai.

## Run it

Requires Node 22.13 or newer.

```bash
npm install
npm start
```

Open http://127.0.0.1:8787. The access token for syncing is created in `data/token`. Enter it under Settings on each device.

To reach the app from your phone, run it behind HTTPS (for example Tailscale Serve or a reverse proxy) with `HOST=0.0.0.0` or a private interface address. Browsers only allow installing and offline mode over HTTPS or localhost.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Listen address |
| `DATA_DIR` | `./data` | SQLite database and token |
| `APP_TOKEN` | generated | Access token |
| `ANTHROPIC_API_KEY` | unset | Turns on the optional AI tutor |
| `TUTOR_MODEL` | `claude-opus-5-5` | Tutor model |
| `TUTOR_DAILY_LIMIT` | `100` | Maximum tutor replies per day |
| `VAPID_SUBJECT` | `https://example.com` | Contact URL or `mailto:` sent to browser push services |

## Daily reminders

Turn reminders on per device under Settings. The server sends at most one per day and skips it once you have practiced on any device. Reminders need HTTPS and a running server. On iPhone and iPad, add the app to the Home Screen first.

## Adding a language

Add `public/packs/<code>.json` using the same shape as `th.json`, list it in `public/packs/index.json`, and add it to the cache list in `public/sw.js`. `voices` holds speaker-dependent words, and `joiner` is the text between tiles (`""` for Thai, `" "` for French or Italian). The app currently loads the first listed pack, so a language picker is the next step when a second pack arrives.

## Tests

```bash
npm test
```
