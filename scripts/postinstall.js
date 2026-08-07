#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const log = (msg) => console.log(`[paytaca] ${msg}`);

function which(cmd) {
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const out = execSync(`${which} ${cmd}`, { encoding: 'utf8' }).trim().split('\n')[0];
    return out || null;
  } catch {
    return null;
  }
}

function runPaytacaVersion() {
  try {
    execSync(`paytaca --version`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function resolveLocalCliBin() {
  try {
    const pkg = require.resolve('paytaca-cli/package.json');
    return path.resolve(path.dirname(pkg), 'bin', 'paytaca.js');
  } catch {}
  const fallback = path.resolve(__dirname, '..', 'node_modules', 'paytaca-cli', 'bin', 'paytaca.js');
  return fs.existsSync(fallback) ? fallback : null;
}

function globalBinDir() {
  try {
    const prefix = execSync('npm prefix -g', { encoding: 'utf8' }).trim();
    if (prefix) return path.join(prefix, process.platform === 'win32' ? '' : 'bin');
  } catch {}
  if (process.platform === 'win32') return null;
  const homeBin = path.join(os.homedir(), '.npm-global', 'bin');
  if (fs.existsSync(homeBin)) return homeBin;
  const nvmBin = process.env.NVM_BIN;
  if (nvmBin) return nvmBin;
  return null;
}

function asdfReshim() {
  try {
    const asdfDir = path.join(os.homedir(), '.asdf');
    if (fs.existsSync(asdfDir) && which('asdf')) {
      execSync('asdf reshim nodejs', { stdio: 'ignore' });
    }
  } catch {}
}

async function linkGlobally(cliBin) {
  const binDir = globalBinDir();
  if (!binDir) throw new Error('Could not determine global bin directory');
  fs.mkdirSync(binDir, { recursive: true });

  const link = path.join(binDir, 'paytaca');
  if (fs.existsSync(link) || fs.lstatSync(link, { throwIfNoEntry: false })) {
    const st = fs.lstatSync(link, { throwIfNoEntry: false });
    if (st && !st.isSymbolicLink()) throw new Error(`${link} exists and is not a symlink`);
    fs.unlinkSync(link);
  }
  fs.symlinkSync(cliBin, link);
  asdfReshim();
  return link;
}

async function main() {
  if (process.env.PAYTACA_PLUGIN_SKIP_POSTINSTALL) return;
  if (which('paytaca') && runPaytacaVersion()) return;

  const cliBin = resolveLocalCliBin();
  if (!cliBin) {
    log('paytaca-cli not found locally; skipping global link.');
    return;
  }

  try {
    const link = await linkGlobally(cliBin);
    log(`Linked paytaca -> ${link}`);
  } catch (err) {
    log(`Could not symlink paytaca globally (${err.message}).`);
    log('Falling back to: npm install -g paytaca-cli');
    try {
      execSync('npm install -g paytaca-cli', { stdio: 'inherit' });
      asdfReshim();
    } catch {
      log('Auto-install failed. Run manually: npm install -g paytaca-cli');
    }
  }
}

main().catch(() => {});
