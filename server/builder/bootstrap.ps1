<powershell>
# Hawkes Gen Unity build server: first-boot setup (EC2 user data, runs once as SYSTEM).
# Filled in by src/providers/builder/builder.ts: __PUBKEY__ __PASSWORD__ __IDLE_MINUTES__ __UNITY_VERSION__ __CHANGESET__
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$H = 'C:\hawkes'
New-Item -ItemType Directory -Force $H, "$H\logs", "$H\incoming", "$H\jobs", "$H\bin", 'C:\Projects' | Out-Null
Set-Content "$H\busy" 'bootstrap'

function Stage($stage, $detail = '') {
  $o = [ordered]@{ stage = $stage; detail = $detail; time = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) }
  ($o | ConvertTo-Json -Compress) | Set-Content "$H\status.json" -Encoding ascii
  Add-Content "$H\bootstrap.log" ("{0} {1} {2}" -f (Get-Date -Format s), $stage, $detail)
}

Stage 'setup' 'remote access'
# Remote Desktop password (saved on J's PC by Hawkes Gen), for the one-time Unity Hub sign-in.
net user Administrator '__PASSWORD__'

# OpenSSH server with the Hawkes Gen key, PowerShell as the shell.
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null
Set-Service sshd -StartupType Automatic
Start-Service sshd
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -PropertyType String -Force | Out-Null
$keys = 'C:\ProgramData\ssh\administrators_authorized_keys'
Set-Content $keys '__PUBKEY__' -Encoding ascii
icacls $keys /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null
if (-not (Get-NetFirewallRule -Name 'sshd-hawkes' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name 'sshd-hawkes' -DisplayName 'OpenSSH (Hawkes Gen)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
}

# Faster builds: long paths, and no virus scanning of projects and the editor.
Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Value 1
Add-MpPreference -ExclusionPath 'C:\Projects', 'C:\Program Files\Unity', $H
Add-MpPreference -ExclusionProcess 'Unity.exe', 'il2cpp.exe', 'clang.exe', 'clang++.exe', 'wasm-ld.exe', 'wasm-opt.exe', 'node.exe', 'python.exe', 'bee_backend.exe'

# Idle stop: every 5 minutes, power off after __IDLE_MINUTES__ minutes with no Unity, no build, nobody signed in.
$idle = @'
$H = 'C:\hawkes'
$minutes = [int](Get-Content "$H\idle-minutes" -ErrorAction SilentlyContinue)
if (-not $minutes) { $minutes = __IDLE_MINUTES__ }
function Touch { (Get-Date).ToUniversalTime().ToString('o') | Set-Content "$H\last-activity" }
if (Test-Path "$H\busy") { Touch; exit }
if (Get-Process Unity -ErrorAction SilentlyContinue) { Touch; exit }
if ((query user 2>$null) -match '\sActive\s') { Touch; exit }
$boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime()
$last = $boot
if (Test-Path "$H\last-activity") { try { $t = [datetime]::Parse((Get-Content "$H\last-activity"), $null, 'RoundtripKind'); if ($t -gt $last) { $last = $t } } catch {} }
if (((Get-Date).ToUniversalTime() - $last).TotalMinutes -gt $minutes) { shutdown /s /t 30 /c 'Hawkes Gen build server: idle' }
'@
Set-Content "$H\bin\idle.ps1" $idle -Encoding ascii
Set-Content "$H\idle-minutes" '__IDLE_MINUTES__'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File $H\bin\idle.ps1"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName 'HawkesIdleStop' -Action $action -Trigger $trigger -User 'SYSTEM' -RunLevel Highest -Force | Out-Null

# Git, so projects are cloned from GitHub (fast here) and only J's local changes are uploaded.
Stage 'setup' 'installing Git'
curl.exe -sSL -o "$H\git.exe" 'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/Git-2.56.0.2-64-bit.exe'
Start-Process "$H\git.exe" -ArgumentList '/VERYSILENT /NORESTART /NOCANCEL /SP- /COMPONENTS=gitlfs' -Wait
Remove-Item "$H\git.exe" -ErrorAction SilentlyContinue
& 'C:\Program Files\Git\cmd\git.exe' config --system core.longpaths true
& 'C:\Program Files\Git\cmd\git.exe' config --system --add safe.directory '*'

# Unity Hub (for the license sign-in) and the editor with WebGL support, the versions J's projects use.
$ed = 'C:\Program Files\Unity\Hub\Editor\__UNITY_VERSION__'
$base = 'https://download.unity3d.com/download_unity/__CHANGESET__'
Stage 'unity' 'downloading Unity Hub'
curl.exe -sSL -o "$H\hub.exe" 'https://public-cdn.cloud.unity3d.com/hub/prod/UnityHubSetup-x64.exe'
Start-Process "$H\hub.exe" -ArgumentList '/S' -Wait
Stage 'unity' 'downloading the Unity __UNITY_VERSION__ editor (4 GB)'
curl.exe -sSL -o "$H\editor.exe" "$base/Windows64EditorInstaller/UnitySetup64-__UNITY_VERSION__.exe"
Stage 'unity' 'installing the editor'
Start-Process "$H\editor.exe" -ArgumentList "/S /D=$ed" -Wait
Stage 'unity' 'downloading WebGL support (1 GB)'
curl.exe -sSL -o "$H\webgl.exe" "$base/TargetSupportInstaller/UnitySetup-WebGL-Support-for-Editor-__UNITY_VERSION__.exe"
Stage 'unity' 'installing WebGL support'
Start-Process "$H\webgl.exe" -ArgumentList "/S /D=$ed" -Wait
Remove-Item "$H\hub.exe", "$H\editor.exe", "$H\webgl.exe" -ErrorAction SilentlyContinue

if ((Test-Path "$ed\Editor\Unity.exe") -and (Test-Path "$ed\Editor\Data\PlaybackEngines\WebGLSupport")) {
  Stage 'license' 'Unity __UNITY_VERSION__ with WebGL is installed. Sign in to Unity Hub once over Remote Desktop to license it.'
} else {
  Stage 'failed' 'Unity did not install (see C:\hawkes\bootstrap.log)'
}
Remove-Item "$H\busy" -ErrorAction SilentlyContinue
</powershell>
<persist>false</persist>
