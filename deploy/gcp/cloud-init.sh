#!/bin/bash
# First boot of the Hawkes control server on Google Compute Engine (Ubuntu 24.04, hawkes-prod, us-east4-c): the same
# system as hawkesstudio/deploy/cloud-init.sh on AWS, plus the users and the agent's metadata firewall up front. Given to
# the VM as user-data by deploy/gcp/provision.mjs. move.mjs puts the code, data, units and secrets in place afterwards.
# Progress: /var/log/hawkes-init.log; done when /var/lib/hawkes/ready exists.
set -euxo pipefail
exec > >(tee -a /var/log/hawkes-init.log) 2>&1

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg git git-lfs ffmpeg python3-venv python3-pip unzip jq debian-keyring debian-archive-keyring apt-transport-https rsync sqlite3 iptables
# The Twitch encoder (On Air): a virtual screen, fonts and Chromium (deploy/broadcast-unit.mjs checks these on every deploy).
apt-get install -y --no-install-recommends xvfb fonts-dejavu-core fonts-noto-color-emoji
snap install chromium

# Node 24
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs

# Caddy (HTTPS with automatic Let's Encrypt certificates; the move copies the AWS server's certificates too)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -y
apt-get install -y caddy

# The service user and the agent sandbox's user (hawkesstudio deploy/agent-sandbox.mjs finishes the sandbox: folders,
# sudoers, wrapper). hawkes-agent is never in group hawkes, so /etc/hawkes/keys.env and /run/hawkes/*.env stay out of reach.
id hawkes >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/hawkes --shell /bin/bash hawkes
getent group hawkes-work >/dev/null || groupadd --system hawkes-work
id hawkes-agent >/dev/null 2>&1 || useradd --system --home-dir /srv/hawkes-agent --create-home --shell /bin/bash --gid hawkes-work hawkes-agent
usermod -aG hawkes-work hawkes
mkdir -p /srv/hawkes /var/lib/hawkes /etc/hawkes
chown hawkes:hawkes /srv/hawkes /var/lib/hawkes
chmod 750 /srv/hawkes-agent

# No metadata server for the agent: on Google it hands out the VM's service-account tokens (Secret Manager, Storage,
# Cloud Run) and its identity token (the AWS role). The same rule as the AWS server's IMDS rule, for the same address,
# plus Google's IPv6 metadata address. Its own unit, so agent-sandbox.mjs's hawkes-agent-firewall can sit beside it.
cat > /usr/local/sbin/hawkes-agent-gce-firewall <<'EOF'
#!/bin/bash
# The Hawkes agent sandbox user can't reach the GCE metadata server (169.254.169.254 = metadata.google.internal).
U=$(id -u hawkes-agent)
iptables -C OUTPUT -m owner --uid-owner "$U" -d 169.254.169.254 -j REJECT 2>/dev/null || iptables -I OUTPUT -m owner --uid-owner "$U" -d 169.254.169.254 -j REJECT
ip6tables -C OUTPUT -m owner --uid-owner "$U" -d fd20:ce::254 -j REJECT 2>/dev/null || ip6tables -I OUTPUT -m owner --uid-owner "$U" -d fd20:ce::254 -j REJECT || true
EOF
chmod 755 /usr/local/sbin/hawkes-agent-gce-firewall
cat > /etc/systemd/system/hawkes-agent-gce-firewall.service <<'EOF'
[Unit]
Description=Hawkes agent sandbox: no GCE metadata server for hawkes-agent
Before=hawkes-studio.service
After=network-pre.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/hawkes-agent-gce-firewall
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now hawkes-agent-gce-firewall.service

# 4 GB of swap (the VM has 16 GB; agents and dev servers peak).
if [ ! -f /swapfile ]; then fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab; fi

# Automatic security updates.
apt-get install -y unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades

touch /var/lib/hawkes/ready
