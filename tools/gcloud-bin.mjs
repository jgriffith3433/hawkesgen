// How Node runs gcloud without a shell. On Windows gcloud is a .cmd under "Cloud SDK" (a space), and cmd.exe mangles
// quoted arguments ("'C:\Users\...\Google\Cloud' is not recognized"); running the SDK's own Python on gcloud.py, with
// no shell at all, passes every argument as it is. Elsewhere it is plain `gcloud`.
//   const [cmd, pre] = gcloudBin(); spawnSync(cmd, [...pre, ...args])
import fs from 'node:fs';
import path from 'node:path';

export function gcloudBin() {
  if (process.platform !== 'win32') return ['gcloud', []];
  const sdk = process.env.CLOUDSDK_ROOT_DIR ?? path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Cloud SDK', 'google-cloud-sdk');
  const py = path.join(sdk, 'platform', 'bundledpython', 'python.exe');
  const main = path.join(sdk, 'lib', 'gcloud.py');
  return fs.existsSync(py) && fs.existsSync(main) ? [py, [main]] : ['gcloud.cmd', []];
}
