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

const PACKAGE_NAME = '@paytaca/opencode-plugin';

// Clean up version-inconsistency traps after a fresh install:
// 1. Remove opencode plugin-cache entries for other versions of this plugin.
// 2. Pin the dependency spec to this exact version in opencode package.jsons
//    (^ ranges on 0.x exclude newer minors, which blocks upgrades).
// 3. Delete lockfiles that still pin an old version (they regenerate).
function selfPin() {
  try {
    const pkgRoot = path.resolve(__dirname, '..');
    const own = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).version;
    if (!own) return;

    // 1. Stale plugin caches (never touch the directory we were installed into)
    const cacheBase = path.join(
      process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'),
      'opencode', 'packages', '@paytaca'
    );
    try {
      for (const entry of fs.readdirSync(cacheBase)) {
        if (entry.indexOf('opencode-plugin') === -1) continue;
        const dir = path.join(cacheBase, entry);
        const resolved = path.resolve(dir);
        const root = path.resolve(pkgRoot);
        if (resolved === root || resolved.startsWith(root + path.sep)) continue;
        let version = null;
        try {
          version = JSON.parse(
            fs.readFileSync(path.join(dir, 'node_modules', PACKAGE_NAME, 'package.json'), 'utf8')
          ).version;
        } catch {}
        if (version !== own) {
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
        }
      }
    } catch {}

    // 2. Exact-pin the spec in every opencode scope referencing the plugin
    const cfgDir = path.join(
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
      'opencode'
    );
    const configDirs = [cfgDir];
    try {
      const projectDir = path.join(process.cwd(), '.opencode');
      if (fs.existsSync(path.join(projectDir, 'package.json'))) configDirs.push(projectDir);
    } catch {}
    for (const dir of configDirs) {
      try {
        const file = path.join(dir, 'package.json');
        if (!fs.existsSync(file)) continue;
        const json = JSON.parse(fs.readFileSync(file, 'utf8'));
        const deps = json.dependencies || {};
        if (typeof deps[PACKAGE_NAME] !== 'string' || deps[PACKAGE_NAME] === own) continue;
        deps[PACKAGE_NAME] = own;
        json.dependencies = deps;
        fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
        log(`Pinned ${PACKAGE_NAME} to ${own} in ${file}`);
      } catch {}
    }

    // 3. Lockfiles pinning an old version would fail integrity on next install
    for (const dir of configDirs) {
      for (const lock of ['package-lock.json', 'bun.lock']) {
        try {
          const file = path.join(dir, lock);
          if (!fs.existsSync(file)) continue;
          if (fs.readFileSync(file, 'utf8').indexOf(PACKAGE_NAME) === -1) continue;
          fs.rmSync(file, { force: true });
          log(`Removed stale ${lock} in ${dir} (regenerates on next install)`);
        } catch {}
      }
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
  selfPin();
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
