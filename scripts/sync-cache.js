const fs = require('fs');
const path = require('path');
const os = require('os');

const cacheDist = path.join(os.homedir(), '.cache/opencode/packages/@paytaca/opencode-plugin@latest/node_modules/@paytaca/opencode-plugin/dist');
const myDist = path.join(__dirname, '..', 'dist');

if (fs.existsSync(cacheDist) && fs.existsSync(myDist)) {
  fs.cpSync(myDist, cacheDist, { recursive: true, force: true });
}