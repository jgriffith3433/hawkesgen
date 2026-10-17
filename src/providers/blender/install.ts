// Which Blender the GPU servers run, and the shell that installs it. Kept apart from blender.ts (no imports) so
// fleet.ts can put it in server/bootstrap.sh without an import cycle.

export const BLENDER_VERSION = '5.0.1';
const TARBALL = `blender-${BLENDER_VERSION}-linux-x64.tar.xz`;
const SHA256 = '8019580ee1b7262e505f4196a00237ccf743c88d205b38d34201510676e60b09';
// download.blender.org refuses scripted downloads; the official mirrors don't.
const MIRRORS = [
  'https://mirrors.ocf.berkeley.edu/blender/release',
  'https://mirror.clarkson.edu/blender/release',
  'https://download.blender.org/release',
];
/** Libraries Blender's Linux build loads even in the background (X11 and GL stubs). */
const DEPS = 'libxi6 libxxf86vm1 libxfixes3 libxrender1 libgl1 libegl1 libxkbcommon0 libxkbcommon-x11-0 libsm6 libice6 libxext6 libx11-6';
export const BLENDER = '/opt/blender/blender';

/** The shell steps that install Blender into /opt/blender-<version>, linked as /opt/blender (idempotent; checks the
 * download's SHA-256). `sudo` is '' where the script already runs as root (server/bootstrap.sh). */
export function installScript(sudo = 'sudo ') {
  const series = BLENDER_VERSION.split('.').slice(0, 2).join('.');
  const urls = MIRRORS.map((m) => `${m}/Blender${series}/${TARBALL}`);
  const apt = `${sudo}apt-get -o DPkg::Lock::Timeout=600`;
  return [
    'set -e',
    `if ! /opt/blender-${BLENDER_VERSION}/blender --version 2>/dev/null | grep -q "Blender ${BLENDER_VERSION}"; then`,
    `  ${apt} install -y ${DEPS} >/tmp/blender-deps.log 2>&1 || (${apt} update -y >/dev/null 2>&1 && ${apt} install -y ${DEPS} >/tmp/blender-deps.log 2>&1)`,
    `  rm -f /tmp/${TARBALL}`,
    `  for u in ${urls.join(' ')}; do curl -fsSL --retry 2 -o /tmp/${TARBALL} "$u" && echo "${SHA256}  /tmp/${TARBALL}" | sha256sum -c --quiet && break; rm -f /tmp/${TARBALL}; done`,
    `  test -f /tmp/${TARBALL}`,
    `  ${sudo}rm -rf /opt/blender-${BLENDER_VERSION} /opt/blender-${BLENDER_VERSION}-linux-x64`,
    `  ${sudo}tar -xJf /tmp/${TARBALL} -C /opt && rm -f /tmp/${TARBALL}`,
    `  ${sudo}mv /opt/blender-${BLENDER_VERSION}-linux-x64 /opt/blender-${BLENDER_VERSION}`,
    'fi',
    `${sudo}ln -sfn /opt/blender-${BLENDER_VERSION} /opt/blender`,
    `${BLENDER} --version 2>/dev/null | head -1`,
  ].join('\n');
}
