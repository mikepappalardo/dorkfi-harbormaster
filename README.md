# DorkFi Harbormaster

Auto-rebalance microservice for DorkFi positions.

Monitors health factor across Voi and Algorand. When a position drops below your configured floor, Harbormaster alerts you via Telegram and/or automatically executes a repayment to restore your target health factor.

## How it works

```
Every N seconds:
  For each watched wallet × chain:
    → Fetch health factor from DorkFi API
    → If HF < floor:
        → Send Telegram alert
        → (execute mode) Auto-repay to restore target HF
    → If HF approaching floor (within 10%):
        → Log early warning
```

## Setup

### 1. Install

```bash
git clone https://github.com/mikepappalardo/dorkfi-harbormaster
cd dorkfi-harbormaster
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Telegram alerts
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Mode: "alert" or "execute"
MODE=alert

# Only needed in execute mode
GUARDIAN_MNEMONIC=word1 word2 word3 ...
```

To get a Telegram bot token: message [@BotFather](https://t.me/BotFather) on Telegram.
To get your chat ID: message [@userinfobot](https://t.me/userinfobot).

### 3. Add wallets to watch

Edit `config.json`:

```json
{
  "wallets": [
    {
      "address": "YOUR_WALLET_ADDRESS",
      "label": "My Main Position",
      "chains": ["voi", "algorand"],
      "hf_floor": 1.4,
      "hf_target": 1.6,
      "action": "alert",
      "notify": true
    }
  ],
  "poll_interval_seconds": 60,
  "alert_cooldown_minutes": 30
}
```

| Field | Description |
|-------|-------------|
| `address` | Wallet address to monitor |
| `label` | Human-readable name for alerts |
| `chains` | `["voi"]`, `["algorand"]`, or `["voi", "algorand"]` |
| `hf_floor` | Alert (and act) when HF drops below this |
| `hf_target` | Target HF to restore to in execute mode |
| `action` | `"alert"` or `"execute"` |
| `notify` | Set to `false` to disable Telegram for this wallet |

### 4. Run

```bash
node harbormaster.mjs
```

## Modes

### Alert mode (default)

Sends a Telegram notification when HF drops below floor. No funds required. No transactions executed.

```
MODE=alert
```

### Execute mode

Automatically repays a portion of the top borrow position to restore the target health factor. Requires a funded harbormaster wallet with the relevant assets.

```
MODE=execute
GUARDIAN_MNEMONIC=word1 word2 ...
```

The harbormaster wallet needs to hold the borrowed asset to repay on behalf of the watched wallet. In self-custody setups, this is typically the same wallet (set `address` = harbormaster wallet address).

## Health factor reference

| HF | Status | Action |
|----|--------|--------|
| ≥ 2.0 | Healthy | None |
| 1.5–2.0 | Safe | None |
| 1.3–1.5 | Watch | Monitor closely |
| 1.1–1.3 | Warning | Consider repaying |
| 1.0–1.1 | Danger | Repay immediately |
| < 1.0 | Liquidatable | Position at risk |

## Run as a service (macOS LaunchAgent)

Create `~/Library/LaunchAgents/com.dorkfi.harbormaster.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.dorkfi.harbormaster</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/absolute/path/to/dorkfi-harbormaster/harbormaster.mjs</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/absolute/path/to/dorkfi-harbormaster</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/absolute/path/to/dorkfi-harbormaster/harbormaster.log</string>
  <key>StandardErrorPath</key>
  <string>/absolute/path/to/dorkfi-harbormaster/harbormaster.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.dorkfi.harbormaster.plist
```

## Run as a service (Linux systemd)

```ini
[Unit]
Description=DorkFi Harbormaster
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/dorkfi-harbormaster
ExecStart=/usr/bin/node harbormaster.mjs
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable dorkfi-harbormaster
sudo systemctl start dorkfi-harbormaster
```

## Data sources

- Health factors: [DorkFi API](https://dorkfi-api.nautilus.sh/api-docs/)
- Markets: `dorkfi-api.nautilus.sh/market-data/{chain}`
- Positions: `dorkfi-api.nautilus.sh/user-health/user/{address}`

## License

MIT
