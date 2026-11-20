# BlueLink test

A 2-day proof that GoHighLevel can send iMessages through this Mac and get replies back.

## How it works

```
GHL workflow -> ngrok -> this Node server (port 3000) -> BlueBubbles (port 1234) -> Messages app -> customer
customer reply -> Messages app -> BlueBubbles webhook -> this server /reply -> GHL API (note on the contact)
```

## Endpoints

| Route | What it does |
|---|---|
| `GET /` | Health check. Returns "BlueLink test bridge is running". |
| `POST /send?secret=...` | Takes `{ phone, message, service? }` and asks BlueBubbles to send it. Returns 401 without the right secret. |
| `POST /reply` | BlueBubbles webhook. On an incoming message it finds the GHL contact by phone and adds a note. |

`service` may be `"sms"` (sends as SMS) — anything else sends as iMessage.

## Setup

```bash
cd ~/bluelink-test
cp .env.example .env     # then fill in the values
npm install
npm start
```

`.env` keys: `BB_URL`, `BB_PASSWORD`, `GHL_TOKEN`, `GHL_LOCATION_ID`, `TEST_SECRET`, `PORT`.

## Running it

```bash
cd ~/bluelink-test
npm start                            # or: nohup npm start > server.log 2>&1 &
tail -f ~/bluelink-test/server.log   # view logs when run in the background
ngrok http 3000                      # public URL for GHL
curl -s http://localhost:4040/api/tunnels   # read the public URL
```

On the ngrok free plan the public URL changes every restart — update the GHL
workflow webhook URL each time.

## Test steps

1. `curl http://localhost:3000/` -> "BlueLink test bridge is running"
2. `curl -X POST http://localhost:3000/send` -> 401 (secret check works)
3. Ping BlueBubbles: `curl "http://localhost:1234/api/v1/ping?password=<BB_PASSWORD>"` -> "pong"
4. Simulate an inbound reply:
   ```bash
   curl -X POST http://localhost:3000/reply \
     -H "Content-Type: application/json" \
     -d '{"type":"new-message","data":{"isFromMe":false,"text":"Fake reply test","handle":{"address":"+918826530568"}}}'
   ```
   The logs should say a note was added; check the contact in GHL.
5. In GHL: workflow with trigger **Contact Tag Added** = `imessage-test`, action
   **Custom Webhook** POST to `<ngrok-url>/send?secret=<TEST_SECRET>` with body
   `{"phone": "{{contact.phone}}", "message": "Hi {{contact.first_name}}, this is a BlueLink test"}`.
   Add the tag to the test contact and watch for a `[send]` line in the logs.

## Notes

- The Messages app is not signed in yet, so real delivery will not work until it is.
  BlueBubbles may queue or error on the send; a `[send]` log line still proves the chain works.
- SIP stays on and the BlueBubbles Private API stays off. Sends use AppleScript.
- Never commit `.env` — it is in `.gitignore`.
