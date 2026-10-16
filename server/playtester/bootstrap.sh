#!/bin/bash
# The playtester: a small GPU machine (NVIDIA T4) that only runs a Playwright browser server for game playtests.
# Hawkes Gen fills in the __PLACEHOLDERS__ and passes this as EC2 user data. It runs once, at the first boot.
#
# - The browser server listens on 127.0.0.1:3600 only; playtests reach it through an SSH tunnel.
# - It powers itself off after __IDLE_MINUTES__ minutes without a playtest (nobody connected to the browser server
#   and /var/lib/hawkes/last_busy untouched). The instance stops on shutdown, it isn't terminated.
set -euo pipefail
exec >>/var/log/hawkes-playtester.log 2>&1
mkdir -p /var/lib/hawkes
status() { printf '{"stage":"%s","detail":"%s","time":%s}\n' "$1" "${2:-}" "$(date +%s)" > /var/lib/hawkes/status.json; }
status installing "setting up the browser server"

install -d -m 700 -o ubuntu -g ubuntu /home/ubuntu/.ssh
echo '__PUBKEY__' >> /home/ubuntu/.ssh/authorized_keys
chown ubuntu:ubuntu /home/ubuntu/.ssh/authorized_keys
chmod 600 /home/ubuntu/.ssh/authorized_keys

# Idle stop first, so a failed install still powers off.
echo __IDLE_MINUTES__ > /var/lib/hawkes/idle-minutes
touch /var/lib/hawkes/last_busy
cat > /usr/local/bin/hawkes-idle.sh <<'IDLE'
#!/bin/bash
# Stops the machine when no playtest has used the browser server for IDLE minutes.
IDLE=$(cat /var/lib/hawkes/idle-minutes 2>/dev/null || echo 20)
if ss -Htn state established '( sport = :3600 )' | grep -q .; then touch /var/lib/hawkes/last_busy; fi
# An SSH login (a tunnel being set up, J looking around) counts too.
if who | grep -q .; then touch /var/lib/hawkes/last_busy; fi
age=$(( $(date +%s) - $(stat -c %Y /var/lib/hawkes/last_busy) ))
if [ "$age" -gt $(( IDLE * 60 )) ]; then echo "idle for ${age}s, powering off"; /sbin/shutdown -h now; fi
IDLE
chmod +x /usr/local/bin/hawkes-idle.sh
cat > /etc/systemd/system/hawkes-idle.service <<'UNIT'
[Unit]
Description=Hawkes playtester idle stop
[Service]
Type=oneshot
ExecStart=/usr/local/bin/hawkes-idle.sh
UNIT
cat > /etc/systemd/system/hawkes-idle.timer <<'UNIT'
[Unit]
Description=Hawkes playtester idle stop, every minute
[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
[Install]
WantedBy=timers.target
UNIT
# A fresh boot counts as busy, so a machine started for a run gets its full idle time.
cat > /etc/systemd/system/hawkes-boot-busy.service <<'UNIT'
[Unit]
Description=Mark the playtester busy at boot
[Service]
Type=oneshot
ExecStart=/usr/bin/touch /var/lib/hawkes/last_busy
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now hawkes-boot-busy.service hawkes-idle.timer

# Node and Playwright (the same version as Hawkes Gen).
mkdir -p /opt/hawkes-node
curl -fsSL __NODE_URL__ | tar -xJ --strip-components=1 -C /opt/hawkes-node
install -d -o ubuntu -g ubuntu /opt/hawkes-pw
export PATH=/opt/hawkes-node/bin:$PATH
cd /opt/hawkes-pw
sudo -u ubuntu env PATH=$PATH HOME=/home/ubuntu sh -c 'npm init -y >/dev/null && npm install --no-audit --no-fund --loglevel=error playwright@__PW_VERSION__'
status installing "installing Chromium"
npx --yes playwright install-deps chromium
sudo -u ubuntu env PATH=$PATH HOME=/home/ubuntu npx playwright install chromium chromium-headless-shell

# The browser server. Playwright's run-server ignores per-connection launch options, so Chromium would fall back to
# software rendering (SwiftShader): launchServer starts it with the GPU flags instead (one browser, many connections).
cat > /opt/hawkes-pw/server.mjs <<'JS'
import { chromium } from '/opt/hawkes-pw/node_modules/playwright/index.mjs';
const args = ['--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-gpu', '--autoplay-policy=no-user-gesture-required', '--mute-audio'];
const server = await chromium.launchServer({ headless: true, args, host: '127.0.0.1', port: Number(process.env.PORT || 3600), wsPath: '/' });
console.log('browser server at', server.wsEndpoint());
server.process().on('exit', (code) => { console.log('browser exited', code); process.exit(1); });
JS
chown ubuntu:ubuntu /opt/hawkes-pw/server.mjs
cat > /etc/systemd/system/hawkes-playwright.service <<'UNIT'
[Unit]
Description=Playwright browser server for Hawkes playtests (127.0.0.1:3600)
After=network-online.target
[Service]
User=ubuntu
Environment=HOME=/home/ubuntu
Environment=PATH=/opt/hawkes-node/bin:/usr/bin:/bin
ExecStart=/opt/hawkes-node/bin/node /opt/hawkes-pw/server.mjs
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now hawkes-playwright.service
status ready "browser server on 127.0.0.1:3600 (Playwright __PW_VERSION__)"
echo "playtester ready"
