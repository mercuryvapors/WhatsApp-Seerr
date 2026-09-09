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

The image is published to GitHub Container Registry on every push:
`ghcr.io/mercuryvapors/whatsapp-seerr:latest`

**Docker Compose:**

```bash
docker compose up -d
```

**Docker run:**

```bash
docker run -d \
  --name whatsapp-seerr \
  -p 7000:7000 \
  --shm-size=1gb \
  -v $(pwd)/data:/data \
  --restart unless-stopped \
  ghcr.io/mercuryvapors/whatsapp-seerr:latest
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

### Install via Community Apps

The app is packaged as a Community Apps template. Users on Unraid 7 can add
this repository as a **custom template source** so it appears in the CA app
list and installs with pre-populated fields (port, data path, env):

1. In Unraid WebUI, open **Apps** → **Settings** → **Template Repositories**
   (or the Community Applications plugin **Template Repositories** tab).
2. Add the following GitHub repository:
   `https://github.com/mercuryvapors/whatsapp-seerr`
3. Update the app feed (Apps → Settings → **Update Apps/Feed**).
4. Search for **whatsapp-seerr** in Apps, click the result, then **Install**.
   The WebUI port, data path, and environment variables are applied
   automatically from `templates/whatsapp-seerr.xml`.

> A submission to the public Community Apps catalog (`ca.unraid.net`) is
> prepared in this repo — see `ca_profile.xml` and `templates/`.

### Manual install (without CA)

Copy `templates/whatsapp-seerr.xml` to your flash drive at
`/config/plugins/dockerMan/templates-user/`, then in Unraid WebUI go to
**Docker → Add Container** and pick **whatsapp-seerr**.

For both methods: map the **Web UI Port** to host `7000`, map a **Data Path**
to `/mnt/user/appdata/whatsapp-seerr`, and in Advanced view add
`--shm-size=1gb` to **Extra Parameters** (see the note above).

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