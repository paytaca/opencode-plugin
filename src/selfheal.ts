import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const PACKAGE_NAME = '@paytaca/opencode-plugin';
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

export interface SelfHealOptions {
  home?: string;
  cwd?: string;
  registryUrl?: string;
  latestVersion?: string;
}

export function compareVersions(a: string, b: string): number {
  const pa = String(a || '').split('-')[0].split('.');
  const pb = String(b || '').split('-')[0].split('.');
  for (let i = 0; i < 3; i++) {
    const na = parseInt(pa[i] || '0', 10) || 0;
    const nb = parseInt(pb[i] || '0', 10) || 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

function configDir(home: string): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? path.join(xdg, 'opencode') : path.join(home, '.config', 'opencode');
}

function cacheBase(home: string): string {
  const xdg = process.env.XDG_CACHE_HOME;
  return xdg ? path.join(xdg, 'opencode', 'packages', '@paytaca') : path.join(home, '.cache', 'opencode', 'packages', '@paytaca');
}

export function readOwnVersion(packageRoot: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    return pkg.version || null;
  } catch {
    return null;
  }
}

async function fetchLatestVersion(registryUrl: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${registryUrl}/${encodeURIComponent(PACKAGE_NAME)}/latest`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data: any = await res.json();
    return data && data.version ? String(data.version) : null;
  } catch {
    return null;
  }
}

// Pin the dependency spec to an exact version in every opencode scope that
// references the plugin. Exact pins (not ^ranges) avoid the 0.x semver trap
// where ^0.1.1 excludes 0.2.0 entirely.
export function updateDependencySpecs(exactVersion: string, opts: SelfHealOptions): string[] {
  const home = opts.home || os.homedir();
  const cwd = opts.cwd || process.cwd();
  const changed: string[] = [];
  const candidates = [
    path.join(configDir(home), 'package.json'),
    path.join(cwd, '.opencode', 'package.json'),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      const deps = json.dependencies || {};
      if (typeof deps[PACKAGE_NAME] !== 'string' || deps[PACKAGE_NAME] === exactVersion) continue;
      deps[PACKAGE_NAME] = exactVersion;
      json.dependencies = deps;
      fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
      changed.push(file);
    } catch {
      // best effort
    }
  }
  return changed;
}

// Remove lockfiles that pin an old version of the plugin — they regenerate on
// the next install. A stale pin (with its old integrity hash) would make the
// next install fail verification instead of fetching the new version.
export function deleteStaleLockfiles(opts: SelfHealOptions): string[] {
  const home = opts.home || os.homedir();
  const cwd = opts.cwd || process.cwd();
  const removed: string[] = [];
  const lockfiles = [
    path.join(configDir(home), 'package-lock.json'),
    path.join(configDir(home), 'bun.lock'),
    path.join(cwd, '.opencode', 'package-lock.json'),
    path.join(cwd, '.opencode', 'bun.lock'),
  ];
  for (const file of lockfiles) {
    try {
      if (!fs.existsSync(file)) continue;
      if (fs.readFileSync(file, 'utf8').indexOf(PACKAGE_NAME) === -1) continue;
      fs.rmSync(file, { force: true });
      removed.push(file);
    } catch {
      // best effort
    }
  }
  return removed;
}

// Drop opencode plugin-cache entries for other versions of the plugin. The
// running instance's code is already loaded in memory, so removing its files
// is safe on unix; failures (e.g. Windows file locks) are ignored.
export function cleanStaleCaches(targetVersion: string, opts: SelfHealOptions): string[] {
  const home = opts.home || os.homedir();
  const base = cacheBase(home);
  const removed: string[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(base);
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (entry.indexOf('opencode-plugin') === -1) continue;
    const dir = path.join(base, entry);
    let version: string | null = null;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', PACKAGE_NAME, 'package.json'), 'utf8'));
      version = pkg.version || null;
    } catch {
      // unreadable/corrupt entry — treat as stale
    }
    if (version === targetVersion) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // best effort — e.g. file locked while running from this directory
    }
  }
  return removed;
}

let healRan = false;

// Runs once per process, without blocking startup: if a newer version is
// published, clear everything that would keep opencode resolving the old one
// (semver-pinned spec, stale lockfiles, stale plugin cache). The next
// `opencode plugin` install or session start then picks up the new version.
export async function runSelfHeal(opts: SelfHealOptions = {}): Promise<void> {
  if (healRan) return;
  healRan = true;
  if (process.env.PAYTACA_SELF_UPDATE === '0') return;
  try {
    const packageRoot = path.resolve(__dirname, '..');
    const own = readOwnVersion(packageRoot);
    if (!own) return;
    const registryUrl = opts.registryUrl || process.env.PAYTACA_NPM_REGISTRY || DEFAULT_REGISTRY;
    const latest = opts.latestVersion || (await fetchLatestVersion(registryUrl));
    if (!latest || compareVersions(latest, own) <= 0) return;

    const specs = updateDependencySpecs(latest, opts);
    const locks = deleteStaleLockfiles(opts);
    const caches = cleanStaleCaches(latest, opts);
    selfHealLog(`update available: ${own} -> ${latest}; specs updated: ${specs.length}, lockfiles removed: ${locks.length}, stale caches removed: ${caches.length}`);
  } catch {
    // never let the self-heal break the plugin
  }
}

function selfHealLog(message: string): void {
  try {
    const home = os.homedir();
    const dir = process.env.PAYTACA_CONFIG_DIR || path.join(home, '.opencode-paytaca');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'selfheal.log'), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // best effort
  }
}
