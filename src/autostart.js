'use strict';

// Auto-start Holdfast on login so every AI-coding session is protected without
// you ever running a command. macOS -> launchd LaunchAgent. Linux -> systemd
// user service. Windows -> prints Task Scheduler instructions.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const LABEL = 'com.holdfast.proxy';
const binPath = path.join(__dirname, '..', 'bin', 'holdfast');
const nodePath = process.execPath;

function macPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function installMac() {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${binPath}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(os.homedir(), '.holdfast', 'stdout.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(os.homedir(), '.holdfast', 'stderr.log')}</string>
</dict>
</plist>
`;
  const p = macPlistPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.mkdirSync(path.join(os.homedir(), '.holdfast'), { recursive: true });
  fs.writeFileSync(p, plist);
  try { execFileSync('launchctl', ['unload', p], { stdio: 'ignore' }); } catch (_) {}
  execFileSync('launchctl', ['load', p]);
  console.log(`✓ Installed launchd agent: ${p}`);
  console.log('  Holdfast will now start automatically on every login and stay running.');
  console.log('  Verify with: holdfast status');
}

function uninstallMac() {
  const p = macPlistPath();
  try { execFileSync('launchctl', ['unload', p], { stdio: 'ignore' }); } catch (_) {}
  if (fs.existsSync(p)) fs.unlinkSync(p);
  console.log(`✓ Removed launchd agent: ${p}`);
}

function systemdPath() {
  return path.join(os.homedir(), '.config', 'systemd', 'user', 'holdfast.service');
}

function installLinux() {
  const unit = `[Unit]
Description=Holdfast resilient AI-API proxy
After=network.target

[Service]
ExecStart=${nodePath} ${binPath} start
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
  const p = systemdPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, unit);
  try {
    execFileSync('systemctl', ['--user', 'daemon-reload']);
    execFileSync('systemctl', ['--user', 'enable', '--now', 'holdfast.service']);
    console.log(`✓ Installed + started systemd user service: ${p}`);
    console.log('  Tip: run `loginctl enable-linger $USER` so it runs even when logged out.');
  } catch (err) {
    console.log(`Wrote unit file ${p}, but could not enable it automatically: ${err.message}`);
    console.log('  Enable manually: systemctl --user enable --now holdfast.service');
  }
}

function uninstallLinux() {
  const p = systemdPath();
  try {
    execFileSync('systemctl', ['--user', 'disable', '--now', 'holdfast.service']);
  } catch (_) {}
  if (fs.existsSync(p)) fs.unlinkSync(p);
  console.log(`✓ Removed systemd user service: ${p}`);
}

function windowsInstructions() {
  console.log(`
Windows auto-start (Task Scheduler):

1. Open Task Scheduler → Create Task…
2. General: name "Holdfast", check "Run only when user is logged on".
3. Triggers: New… → Begin the task: "At log on".
4. Actions: New… → Program/script:
     ${nodePath}
   Add arguments:
     "${binPath}" start
5. OK. Holdfast now starts at every login.

Or run it manually anytime with:  node "${binPath}" start
`);
}

function install() {
  const platform = os.platform();
  if (platform === 'darwin') return installMac();
  if (platform === 'linux') return installLinux();
  if (platform === 'win32') return windowsInstructions();
  console.log(`Auto-start not scripted for platform "${platform}". Run \`holdfast start\` manually or add it to your startup.`);
}

function uninstall() {
  const platform = os.platform();
  if (platform === 'darwin') return uninstallMac();
  if (platform === 'linux') return uninstallLinux();
  console.log('Nothing to uninstall on this platform (auto-start was manual).');
}

module.exports = { install, uninstall };
