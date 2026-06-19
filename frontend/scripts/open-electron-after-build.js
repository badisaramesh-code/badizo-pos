const { spawn } = require('child_process');
const path = require('path');

const electronDir = path.resolve(__dirname, '..', '..', 'electron');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const launchCommand = process.platform === 'win32' ? 'cmd.exe' : npmCommand;
const launchArgs =
  process.platform === 'win32'
    ? ['/d', '/s', '/c', 'start', '""', '/D', electronDir, npmCommand, 'start']
    : ['start'];

try {
  const appProcess = spawn(launchCommand, launchArgs, {
    cwd: electronDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });

  appProcess.on('error', (error) => {
    console.error(`Unable to open Badizo desktop app: ${error.message}`);
    process.exitCode = 1;
  });

  appProcess.unref();
  console.log('Opening Badizo desktop app...');
} catch (error) {
  console.error(`Unable to open Badizo desktop app: ${error.message}`);
  process.exitCode = 1;
}
