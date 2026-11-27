# Keep Talking

Five-minute daily practice for everyday conversation and sentence building, in Thai and Hebrew.

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
| `ANTHROPIC_API_KEY` | unset | Turns on the built-in AI tutor and exercise generation |
| `TUTOR_MODEL` | `claude-opus-5-5` | Tutor model |
| `TUTOR_DAILY_LIMIT` | `100` | Maximum API calls per day (tutor replies and exercise generation together) |
| `VAPID_SUBJECT` | `https://example.com` | Contact URL or `mailto:` sent to browser push services |

## New exercises without an API key

Under **My words → New exercises**, *Copy prompt* puts a prompt on the clipboard with your level, how you speak, and which words you know, are learning, or keep getting wrong. Paste it into any chat app (ChatGPT, Claude, Gemini, …) and paste the whole reply back. The app reads the JSON block, keeps the items that pass its checks (every sentence word must be known or newly defined, conversations need one correct and two wrong replies) and tells you what it skipped. Imported sets sync like the rest of your progress and can be removed again.

With `ANTHROPIC_API_KEY` set, *Generate with API* sends the same prompt from the server and runs the reply through the same checks. The **Tutor** tab works the same way: *Copy prompt for a chat app* is free, the built-in tutor uses the API.

## Letters and sounds

Packs can include a `letters` list. A learner who can't read the script yet starts with letters only: first "what sound does this letter make?", then "which letter makes this sound?", with the letter's name and an example word. Words and conversations begin once every letter has been introduced. Learners who already read can turn letters on in Settings and get one or two alongside their usual practice. The **Letters** tab is a reference chart.

Sound comes from the device's text-to-speech voice (Hebrew `he-IL`, Thai `th-TH`). Most phones have both; some desktop Linux browsers have neither, and the button then says so. To use recordings instead, put files in `public/audio/` and set `audio` (the letter name) or `wordAudio` (the example word) on a letter, for example `"audio": "/audio/he/bet.mp3"`.

## Daily reminders

Turn reminders on per device under Settings. The server sends at most one per day and skips it once you have practiced on any device. Reminders need HTTPS and a running server. On iPhone and iPad, add the app to the Home Screen first.

## Adding a language

Add `public/packs/<code>.json` using the same shape as `th.json` or `he.json`, list it in `public/packs/index.json`, and add it to the cache list in `public/sw.js`.

- `voices` holds speaker-dependent words as `{token}` placeholders. Thai uses them for ผม/ฉัน and the polite particles; Hebrew uses them for verbs and adjectives that agree with the speaker (`{like}` is אוהב or אוהבת). A word entry may itself be a placeholder, so its card is shared across voices.
- `joiner` is the text between tiles (`""` for Thai, `" "` for Hebrew).
- `dir` is `"rtl"` for right-to-left scripts, `speech` is the text-to-speech language, and `pron` maps words to a pronunciation shown after answering (voices can carry their own `pron`).
- `letters` is optional; see above.

## Tests

```bash
npm test
```
