#!/usr/bin/env node
const path = require('path');
const { spawn } = require('child_process');

const paytacaCliPkg = require.resolve('paytaca-cli/package.json');
const binScript = path.resolve(path.dirname(paytacaCliPkg), 'bin', 'paytaca.js');

const child = spawn(process.execPath, [binScript, ...process.argv.slice(2)], {
  stdio: 'inherit'
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
