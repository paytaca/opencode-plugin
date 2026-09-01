#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const log = (msg) => console.log(`[paytaca] ${msg}`);
const IS_WIN = process.platform === 'win32';

function which(cmd) {
  try {
    // 'where' on Windows may return CRLF-separated matches; take the first.
    const w = IS_WIN ? 'where' : 'which';
    const out = execSync(`${w} ${cmd}`, { encoding: 'utf8' }).trim();
    return out ? out.split(/\r?\n/)[0].trim() : null;
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
    if (prefix) return IS_WIN ? prefix : path.join(prefix, 'bin');
  } catch {}
  if (IS_WIN) return null;
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

const norm = (p) => path.resolve(p);
// `win` allows tests to exercise Windows path semantics without touching
// the real process.platform (which child_process.execSync reads to pick its
// shell). Defaults to the running platform.
function normKey(p, win) {
  win = win === undefined ? IS_WIN : win;
  const r = norm(p);
  return win ? r.toLowerCase() : r;
}
// Is `child` the same as, or located beneath, `parent`?
function isInside(child, parent, win) {
  const c = normKey(child, win);
  const p = normKey(parent, win);
  return c === p || c.startsWith(p + path.sep);
}

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
        // Paths are case-insensitive on Windows; compare normalized keys.
        if (isInside(pkgRoot, dir)) continue;
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

    // 2. Exact-pin the spec in every opencode scope referencing the plugin.
    //    npm runs lifecycle scripts with cwd = the package install dir, so
    //    consider both `<cwd>/.opencode` and `<cwd>` itself as project scopes.
    const cfgDir = path.join(
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
      'opencode'
    );
    const cwd = process.cwd();
    const seen = new Set();
    const configDirs = [];
    for (const d of [cfgDir, path.join(cwd, '.opencode'), cwd]) {
      if (isInside(d, pkgRoot)) continue;
      const key = normKey(d);
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        if (fs.existsSync(path.join(d, 'package.json'))) configDirs.push(d);
      } catch {}
    }
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

// `opts.platform`/`opts.binDir` let tests drive the Windows/unix branches
// deterministically; in production they default to the running platform and a
// resolved global bin directory.
async function linkGlobally(cliBin, opts) {
  opts = opts || {};
  const win = opts.platform ? opts.platform === 'win32' : IS_WIN;
  const binDir = opts.binDir || globalBinDir();
  if (!binDir) throw new Error('Could not determine global bin directory');
  fs.mkdirSync(binDir, { recursive: true });

  if (win) {
    // Windows can't run shebang'd .js files, and symlinking requires admin /
    // Developer Mode. Ship a .cmd shim (used by cmd.exe and PowerShell) plus a
    // POSIX-style wrapper so Git-Bash / MSYS users get a working `paytaca` too.
    const cmdFile = path.join(binDir, 'paytaca.cmd');
    fs.writeFileSync(cmdFile, '@echo off\r\nnode "' + cliBin + '" %*\r\n', 'utf8');
    try {
      const shFile = path.join(binDir, 'paytaca');
      fs.writeFileSync(shFile, '#!/bin/sh\nexec node "' + cliBin + '" "$@"\n', 'utf8');
      fs.chmodSync(shFile, '755');
    } catch {}
    return cmdFile;
  }

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
    log(`Could not link paytaca globally (${err.message}).`);
    log('Falling back to: npm install -g paytaca-cli');
    try {
      execSync('npm install -g paytaca-cli', { stdio: 'inherit' });
      asdfReshim();
    } catch {
      log('Auto-install failed. Run manually: npm install -g paytaca-cli');
    }
  }
}

// Export helpers for tests. When run as a script (npm postinstall), main()
// executes; when required by a test, only the functions are exposed.
if (require.main === module) {
  main().catch(() => {});
}

module.exports = {
  which,
  runPaytacaVersion,
  resolveLocalCliBin,
  globalBinDir,
  asdfReshim,
  selfPin,
  linkGlobally,
  isInside,
  normKey,
  IS_WIN,
};
