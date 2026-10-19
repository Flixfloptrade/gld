const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
let stopping = false;
const children = [
  { name: 'main backend', file: path.join(root, 'server.js') },
  { name: 'admin portal', file: path.join(root, 'admin-server.js') },
].map(service => {
  const child = spawn(process.execPath, [service.file], { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true });
  child.on('error', error => {
    process.stderr.write(`${service.name} failed to start: ${error.message}\n`);
    shutdown(1);
  });
  child.on('exit', (code, signal) => {
    if (!stopping && code !== 0) {
      process.stderr.write(`${service.name} exited (${signal || code}). Stopping the other service.\n`);
      shutdown(code || 1);
    }
  });
  return child;
});
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (!child.killed) child.kill();
  process.exitCode = code;
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
