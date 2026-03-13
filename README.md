# Bose SoundTouch Web Controller

A self-hosted multi-room web controller for Bose SoundTouch speakers.
Built with Node.js / Express on the backend, vanilla HTML/CSS/JS on the frontend.

---

## Requirements

- Ubuntu server on the **same LAN** as your SoundTouch speakers
- Node.js 18+ (`node --version`)
- Your speakers' local IP addresses (check your router's DHCP table)

> ⚠️ The SoundTouch API (port 8090/8080) is local-network only.
> Your server must be on the same subnet as the speakers.

---

## Quick Start

```bash
# 1. Clone / copy the project to your server
cd /opt
sudo git clone <your-repo> soundtouch   # or scp the folder over
cd soundtouch

# 2. Install dependencies
npm install

# 3. Edit speakers.json with your real speaker IPs
nano speakers.json

# 4. Start the server
npm start
# → http://localhost:3000
```

---

## Configure Speakers

Edit `speakers.json` before starting (or add/remove via the UI):

```json
[
  { "id": "speaker1", "name": "Living Room", "ip": "192.168.1.100" },
  { "id": "speaker2", "name": "Kitchen",     "ip": "192.168.1.101" },
  { "id": "speaker3", "name": "Master Bed",  "ip": "192.168.1.102" }
]
```

---

## Run as a systemd Service (recommended)

```bash
# Create service file
sudo nano /etc/systemd/system/soundtouch.service
```

Paste:

```ini
[Unit]
Description=Bose SoundTouch Web Controller
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/soundtouch
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable soundtouch
sudo systemctl start soundtouch
sudo systemctl status soundtouch
```

---

## Expose via Nginx (optional, for domain/SSL)

```bash
sudo apt install nginx -y
sudo nano /etc/nginx/sites-available/soundtouch
```

```nginx
server {
    listen 80;
    server_name soundtouch.yourdomain.com;  # or your server's LAN IP

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection keep-alive;
        proxy_set_header   Host $host;
        proxy_cache_bypass $http_upgrade;

        # Required for Server-Sent Events (real-time updates)
        proxy_buffering    off;
        proxy_read_timeout 86400s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/soundtouch /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Add SSL with Certbot if desired:
```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d soundtouch.yourdomain.com
```

---

## API Reference (backend routes)

| Method | Route                    | Description                        |
|--------|--------------------------|------------------------------------|
| GET    | /api/speakers            | List all speakers                  |
| POST   | /api/speakers            | Add speaker `{name, ip}`           |
| DELETE | /api/speakers/:id        | Remove speaker                     |
| GET    | /api/:id/now_playing     | Current playback info              |
| GET    | /api/:id/volume          | Current volume                     |
| POST   | /api/:id/volume          | Set volume `{volume: 0-100}`       |
| GET    | /api/:id/bass            | Current bass                       |
| POST   | /api/:id/bass            | Set bass `{bass: -9 to 9}`         |
| GET    | /api/:id/presets         | List presets 1–6                   |
| POST   | /api/:id/select          | Play ContentItem `{ContentItem}`   |
| GET    | /api/:id/sources         | List available sources             |
| POST   | /api/:id/key             | Send key `{key: "PLAY"}`           |
| GET    | /api/:id/zone            | Get current zone                   |
| POST   | /api/:id/setZone         | Create zone                        |
| POST   | /api/:id/removeZone      | Remove slaves from zone            |
| GET    | /api/events              | SSE stream for real-time updates   |

### Supported Keys
`PLAY`, `PAUSE`, `STOP`, `NEXT_TRACK`, `PREV_TRACK`, `MUTE`, `POWER`,
`SHUFFLE_ON`, `SHUFFLE_OFF`, `REPEAT_ONE`, `REPEAT_ALL`, `REPEAT_OFF`,
`THUMBS_UP`, `THUMBS_DOWN`, `BOOKMARK`

---

## Notes on Bose SoundTouch EOL

Bose shut down SoundTouch cloud servers in 2026. Local LAN control via
this API continues to work fully — playback of locally available sources
(Bluetooth, AUX, Spotify Connect if configured) and preset recall are
all unaffected. Streaming services that required Bose cloud auth will
no longer be available.
