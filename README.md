# WhatsApp Seerr Bridge

Bridge WhatsApp to Seerr (Overseerr / Jellyseerr) so users can request movies and TV shows from a WhatsApp chat. Includes a full web UI for configuration.

## Features

- Connect a WhatsApp account (scan QR code, persistent session)
- Users request media with simple chat commands
- Full web UI on port `7000` for configuration
- Restrict bot usage to specific phone numbers
- Docker image for Unraid

## Chat Commands

| Command | Action |
|---------|--------|
| `!request <title>` | Requests media (auto-detects movie vs TV) |
| `!request movie <title>` | Requests a movie |
| `!request tv <title>` | Requests a TV show |
| `!help` | Shows available commands |

Example: `!request Dune` → searches Seerr and submits the request.

## Setup

### Step 1 — Run the container

**Docker Compose:**

```bash
docker compose up -d --build
```

**Docker run:**

```bash
docker run -d \
  --name whatsapp-seerr \
  -p 7000:7000 \
  --shm-size=1gb \
  -v $(pwd)/data:/data \
  --restart unless-stopped \
  whatsapp-seerr:latest
```

> **Note on `--shm-size=1gb`:** Chromium's renderer crashes with the Docker default 64MB `/dev/shm`, which shows up as *"Navigating frame was detached"*. The app also passes `--disable-dev-shm-usage` as a fallback, but the larger shared memory is the proper fix. If the container is started via the web UI/template, add `--shm-size=1gb` to the Extra Parameters.

### Step 2 — Configure in the web UI

1. Open `http://yourhost:7000`
2. In **Seerr Settings**: enter your Overseerr/Jellyseerr URL and API key, toggle Enable.
3. In **WhatsApp Settings**: optionally restrict to your allowed phone numbers, then click **Connect WhatsApp**.
4. Scan the QR code with your phone (WhatsApp → Linked Devices → Link a Device). This creates a persistent session so you don't rescan each restart.
5. Click **Save & Apply**.

### Step 3 — Request media

Send a message to the linked WhatsApp number:

```
!request Dune
!request tv Severance
!request movie Inception
```

## Unraid

1. Add the container via the Community Applications or with a manual template.
2. Map the **Web UI Port** to host port `7000`.
3. Map a **Data Path** to `/mnt/user/appdata/whatsapp-seerr` (keeps session + config persistent).
4. Open the WebUI from the Unraid dashboard.

A ready `unraid-template.xml` is included for manual template import.

### Deploy on another machine (offline / tar)

If the target machine can't reach Docker Hub (or you just want to move a
pre-built image), use the `docker save`/`docker load` flow:

**Step 1 — on ANY machine with Docker + internet:**

```bash
./build-and-save.sh
```

This builds the image and writes `whatsapp-seerr.tar` (~800MB — it bundles
Puppeteer's Chrome).

**Step 2 — copy to the target machine:**

Copy `whatsapp-seerr.tar`, `load-on-unraid.sh` and `unraid-template.xml`
(USB drive / network share).

**Step 3 — on the Unraid host:**

```bash
./load-on-unraid.sh     # docker load -i whatsapp-seerr.tar
```

The image is now available as `whatsapp-seerr:latest` — the exact name the
included `unraid-template.xml` references, so Unraid won't try to pull it
from a registry.

**Step 4 — add the container:**

1. Copy `unraid-template.xml` to your flash drive at `/config/plugins/dockerMan/templates-user/`
2. Unraid WebUI → **Docker** → **Add Container** → pick the **WhatsAppSeerrBridge** template
3. Set the **Data Path** (e.g. `/mnt/user/appdata/whatsapp-seerr`) and the host port
4. Click **Apply**, then open the WebUI (port `7000`) to configure

## Configuration

All settings are stored in `/data/config.json` at runtime and editable from the web UI:

- **WhatsApp**: enable/disable, command prefix, allowed phone numbers
- **Seerr**: URL, API key, enabled toggle
- **General**: app name, web UI port

## Environment Variables

| Variable   | Default | Description                          |
|------------|---------|--------------------------------------|
| `DATA_DIR` | `/data` | Where config/session data is stored  |
| `PORT` | `7000` | HTTP port (env overrides config)     |
| `CHROME_PATH` | unset | Optional: path to a custom Chrome binary; Puppeteer's own Chrome is used by default |

## Notes

- The first container start downloads/provisions nothing; Chromium ships with the image.
- Keep the `/data` volume mapped — it stores your WhatsApp session and config.
- Only phone numbers in **Allowed Phone Numbers** can use the bot. Empty = everyone allowed.

## Disclaimer

This project is not affiliated with WhatsApp, Meta, Overseerr, or Jellyseerr. Use at your own risk. Scanning a QR code links a WhatsApp Web session to the account you scan with; use a dedicated number for bots if desired.