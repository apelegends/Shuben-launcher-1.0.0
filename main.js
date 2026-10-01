'use strict';
const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Client, Authenticator } = require('minecraft-launcher-core');
const { Auth } = require('msmc');
const AdmZip = require('adm-zip');

/* ---------- paths & helpers ---------- */
const DATA = () => app.getPath('userData');
const GAME_DIR = () => path.join(DATA(), 'minecraft');
const SERVERS_DIR = () => path.join(DATA(), 'servers');
const RUNTIME_DIR = () => path.join(DATA(), 'runtime');
const AUTH_FILE = () => path.join(DATA(), 'auth.bin');
const META_FILE = 'cubelaunch-server.json';
const ACC_FILE = () => path.join(DATA(), 'accounts.json');
const UA = 'shuben-launcher/1.0.0';
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const ADOPT_OS = IS_WIN ? 'windows' : IS_MAC ? 'mac' : 'linux';
const ADOPT_ARCH = process.arch === 'arm64' ? 'aarch64' : 'x64';
const EXE = (n) => (IS_WIN ? n + '.exe' : n);
const ARGS_FILE = IS_WIN ? 'win_args.txt' : 'unix_args.txt';

let win;
const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };
const log = (m) => send('log', String(m));
const status = (m) => send('status', String(m));
const exists = async (p) => { try { await fsp.access(p); return true; } catch { return false; } };

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`Request failed (${r.status}): ${url}`);
  return r.json();
}
async function fetchBuffer(url) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`Download failed (${r.status}): ${url}`);
  return Buffer.from(await r.arrayBuffer());
}
async function download(url, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, await fetchBuffer(url));
}
function safeJoin(root, rel) {
  const p = path.resolve(root, rel);
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error('Unsafe path in modpack: ' + rel);
  return p;
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'server';
const validId = (id) => typeof id === 'string' && /^[a-z0-9-]+$/.test(id);

function runProc(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, windowsHide: true });
    let tail = '';
    const keep = (d) => { tail = (tail + d.toString()).slice(-2000); };
    p.stdout.on('data', keep); p.stderr.on('data', keep);
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Installer exited with code ${code}\n${tail}`))));
  });
}

/* ---------- Mojang metadata & Java ---------- */
let manifestCache;
async function versionManifest() {
  if (!manifestCache) manifestCache = await getJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
  return manifestCache;
}
async function versionJson(id) {
  const m = await versionManifest();
  const v = m.versions.find((x) => x.id === id);
  if (!v) throw new Error('Unknown Minecraft version: ' + id);
  return { meta: v, json: await getJson(v.url) };
}

// Downloads a Temurin JRE the first time a Java major version is needed.
async function ensureJava(major) {
  const dir = path.join(RUNTIME_DIR(), `java-${major}`);
  const find = async () => {
    try {
      const sub = (await fsp.readdir(dir)).find((n) => !n.startsWith('.'));
      if (sub) {
        const bin = IS_MAC ? path.join(dir, sub, 'Contents', 'Home', 'bin') : path.join(dir, sub, 'bin');
        if (await exists(path.join(bin, EXE('java')))) return bin;
      }
    } catch { /* not installed yet */ }
    return null;
  };
  let bin = await find();
  if (bin) return bin;
  status(`Downloading Java ${major} (one time)...`);
  const tmp = path.join(RUNTIME_DIR(), `java-${major}.${IS_WIN ? 'zip' : 'tar.gz'}`);
  await download(`https://api.adoptium.net/v3/binary/latest/${major}/ga/${ADOPT_OS}/${ADOPT_ARCH}/jre/hotspot/normal/eclipse`, tmp);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  if (IS_WIN) new AdmZip(tmp).extractAllTo(dir, true);
  else await runProc('tar', ['-xzf', tmp, '-C', dir], RUNTIME_DIR());
  await fsp.rm(tmp, { force: true });
  bin = await find();
  if (!bin) throw new Error('Java installation failed.');
  return bin;
}

/* ---------- Microsoft sign-in ---------- */
const authManager = new Auth('select_account');
let mc = null;
let mcAt = 0;
let demoGuest = false; // playing Mojang's free demo without signing in

async function saveRefresh(xbox) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return;
    await fsp.writeFile(AUTH_FILE(), safeStorage.encryptString(xbox.save()));
  } catch (e) { log('Could not remember login: ' + e.message); }
}
async function establish(xbox) {
  mc = await xbox.getMinecraft();
  mcAt = Date.now();
  await saveRefresh(xbox);
}
async function ensureSession() {
  if (mc && Date.now() - mcAt < 6 * 3600e3) return;
  let buf;
  try { buf = await fsp.readFile(AUTH_FILE()); } catch { throw new Error('Not signed in.'); }
  const xbox = await authManager.refresh(safeStorage.decryptString(buf));
  await establish(xbox);
}
async function api(pathname, opts = {}) {
  await ensureSession();
  const r = await fetch('https://api.minecraftservices.com' + pathname, {
    ...opts,
    headers: { Authorization: `Bearer ${mc.mcToken}`, ...(opts.headers || {}) },
  });
  if (!r.ok) {
    if (r.status === 404 && pathname === '/minecraft/profile') throw new Error('This Microsoft account does not own Minecraft: Java Edition.');
    throw new Error(`Minecraft services error ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  return r.status === 204 ? null : r.json().catch(() => null);
}
async function getProfile() {
  if (demoGuest) return { id: '', name: 'Default player', skins: [], capes: [], demo: true, guest: true };
  await ensureSession();
  // Microsoft accounts without Minecraft get Mojang's official single-player demo.
  if (mc.isDemo()) return { id: '', name: 'Default player', skins: [], capes: [], demo: true, guest: false };
  const p = await api('/minecraft/profile');
  return { id: p.id, name: p.name, skins: p.skins || [], capes: p.capes || [], demo: false, guest: false };
}

ipcMain.handle('auth:login', async () => {
  const xbox = await authManager.launch('electron');
  await establish(xbox);
  demoGuest = false;
  return getProfile();
});
ipcMain.handle('auth:auto', async () => {
  try { return await getProfile(); } catch { return null; }
});
ipcMain.handle('auth:demo', async () => {
  demoGuest = true;
  return getProfile();
});
ipcMain.handle('auth:logout', async () => {
  mc = null;
  demoGuest = false;
  await fsp.rm(AUTH_FILE(), { force: true });
  return true;
});
ipcMain.handle('profile:get', () => getProfile());

ipcMain.handle('app:quit', () => { app.quit(); return true; });

/* ---------- Play ---------- */
ipcMain.handle('versions:list', async (_e, refresh) => {
  if (refresh) manifestCache = null;
  const m = await versionManifest();
  return { versions: m.versions.map((v) => ({ id: v.id, type: v.type })), latest: m.latest };
});

/* ---------- accounts (Microsoft + local offline profiles) ---------- */
async function readAcc() {
  try { return JSON.parse(await fsp.readFile(ACC_FILE(), 'utf8')); } catch { return { offline: [] }; }
}
const validName = (n) => typeof n === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(n);
ipcMain.handle('acc:list', async () => (await readAcc()).offline);
ipcMain.handle('acc:add', async (_e, name) => {
  if ((await getProfile()).demo) throw new Error('Offline profiles need a Microsoft account that owns Minecraft: Java Edition.');
  if (!validName(name)) throw new Error('Username must be 3-16 letters, numbers or underscores.');
  const acc = await readAcc();
  if (!acc.offline.includes(name)) acc.offline.push(name);
  await fsp.writeFile(ACC_FILE(), JSON.stringify(acc, null, 2));
  return acc.offline;
});
ipcMain.handle('acc:remove', async (_e, name) => {
  const acc = await readAcc();
  acc.offline = acc.offline.filter((n) => n !== name);
  await fsp.writeFile(ACC_FILE(), JSON.stringify(acc, null, 2));
  return acc.offline;
});

/* ---------- Fabric for the game ---------- */
async function ensureFabric(mcVer) {
  const loaders = await getJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVer)}`);
  const entry = loaders.find((l) => l.loader.stable) || loaders[0];
  if (!entry) throw new Error(`Fabric does not support Minecraft ${mcVer} yet.`);
  const id = `fabric-loader-${entry.loader.version}-${mcVer}`;
  const file = path.join(GAME_DIR(), 'versions', id, `${id}.json`);
  if (!(await exists(file))) {
    const j = await getJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVer)}/${entry.loader.version}/profile/json`);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify(j));
  }
  return id;
}

let gameRunning = false;
ipcMain.handle('game:launch', async (_e, { version, ramGb, account, loader, mode }) => {
  if (gameRunning) throw new Error('Minecraft is already running.');
  if (!demoGuest) await ensureSession();
  const { meta, json } = await versionJson(String(version));
  const ram = Math.min(Math.max(parseInt(ramGb, 10) || 4, 1), 32);
  const bin = await ensureJava(json.javaVersion?.majorVersion ?? 8);
  const demo = demoGuest || mode === 'default' || mc.isDemo();
  if (demo && ((account && account !== 'microsoft') || loader === 'fabric')) throw new Error('Default mode is vanilla single-player only.');
  let authorization;
  if (account && account !== 'microsoft') {
    if (!validName(account) || !(await readAcc()).offline.includes(account)) throw new Error('Unknown offline profile.');
    authorization = await Authenticator.getAuth(account);
  } else if (demoGuest) {
    authorization = { ...(await Authenticator.getAuth('Demo_Player')), meta: { type: 'msa', demo: true } };
  } else {
    authorization = mc.mclc();
    if (demo) authorization.meta.demo = true;
  }
  const customId = loader === 'fabric' ? await ensureFabric(meta.id) : undefined;
  await fsp.mkdir(path.join(GAME_DIR(), 'mods'), { recursive: true });
  const launcher = new Client();
  launcher.on('debug', (m) => log(m));
  launcher.on('data', (m) => log(m));
  launcher.on('progress', (p) => send('progress', { label: p.type, pct: p.total ? Math.round((p.task / p.total) * 100) : 0 }));
  launcher.on('close', (code) => { gameRunning = false; send('game:closed', code); });
  status('Preparing game files...');
  gameRunning = true;
  const proc = await launcher.launch({
    authorization,
    root: GAME_DIR(),
    javaPath: path.join(bin, EXE(IS_WIN ? 'javaw' : 'java')),
    version: customId ? { number: meta.id, type: meta.type, custom: customId } : { number: meta.id, type: meta.type },
    memory: { max: `${ram}G`, min: '1G' },
  });
  if (!proc) { gameRunning = false; throw new Error('Minecraft failed to start. Check the log.'); }
  status('Minecraft is running.');
  return true;
});

/* ---------- Skins & capes ---------- */
ipcMain.handle('skin:upload', async (_e, { variant }) => {
  if ((await getProfile()).demo) throw new Error('Skins need a Microsoft account that owns Minecraft: Java Edition.');
  const pick = await dialog.showOpenDialog(win, { title: 'Choose a skin (PNG)', filters: [{ name: 'PNG image', extensions: ['png'] }], properties: ['openFile'] });
  if (pick.canceled) return null;
  const buf = await fsp.readFile(pick.filePaths[0]);
  const isPng = buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47;
  const w = isPng ? buf.readUInt32BE(16) : 0;
  const h = isPng ? buf.readUInt32BE(20) : 0;
  if (!isPng || w !== 64 || (h !== 64 && h !== 32)) throw new Error('Skin must be a 64x64 (or 64x32) PNG.');
  const fd = new FormData();
  fd.append('variant', variant === 'slim' ? 'slim' : 'classic');
  fd.append('file', new Blob([buf], { type: 'image/png' }), 'skin.png');
  await api('/minecraft/profile/skins', { method: 'POST', body: fd });
  return getProfile();
});
ipcMain.handle('cape:set', async (_e, capeId) => {
  if ((await getProfile()).demo) throw new Error('Capes need a Microsoft account that owns Minecraft: Java Edition.');
  if (capeId) {
    await api('/minecraft/profile/capes/active', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capeId: String(capeId) }),
    });
  } else {
    await api('/minecraft/profile/capes/active', { method: 'DELETE' });
  }
  return getProfile();
});

/* ---------- Servers from modpacks ---------- */
const running = new Map();
const HOST_ALLOW = ['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com'];

function setProp(text, key, value) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, `${key}=${value}`) : text + (text && !text.endsWith('\n') ? '\n' : '') + `${key}=${value}\n`;
}

async function fetchPackFile(dir, f) {
  const url = (f.downloads || []).find((u) => { try { return HOST_ALLOW.includes(new URL(u).hostname); } catch { return false; } });
  if (!url) throw new Error(`No allowed download host for ${f.path}`);
  const dest = safeJoin(dir, f.path);
  const buf = await fetchBuffer(url);
  const want = f.hashes?.sha512;
  if (want && crypto.createHash('sha512').update(buf).digest('hex') !== want) throw new Error(`Hash mismatch for ${f.path}`);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, buf);
}

async function createServer({ name, ramGb, port, eula }) {
  if (!eula) throw new Error('Accept the Minecraft EULA to create a server.');
  const pick = await dialog.showOpenDialog(win, { title: 'Choose a modpack (.mrpack)', filters: [{ name: 'Modrinth modpack', extensions: ['mrpack'] }], properties: ['openFile'] });
  if (pick.canceled) return null;

  const zip = new AdmZip(pick.filePaths[0]);
  const idxEntry = zip.getEntry('modrinth.index.json');
  if (!idxEntry) throw new Error('That is not a .mrpack file. CurseForge zips are not supported; download the pack from Modrinth or export it as .mrpack.');
  const index = JSON.parse(zip.readAsText(idxEntry));
  const deps = index.dependencies || {};
  const mcVer = deps.minecraft;
  if (!mcVer) throw new Error('Modpack does not declare a Minecraft version.');
  if (deps['quilt-loader']) throw new Error('Quilt packs are not supported yet (Vanilla, Fabric, Forge, NeoForge are).');

  const ram = Math.min(Math.max(parseInt(ramGb, 10) || 4, 1), 32);
  const portNum = Math.min(Math.max(parseInt(port, 10) || 25565, 1024), 65535);
  const label = String(name || index.name || 'Server').slice(0, 48);
  const id = slug(label) + '-' + Date.now().toString(36);
  const dir = path.resolve(SERVERS_DIR(), id);
  await fsp.mkdir(dir, { recursive: true });

  try {
    // 1. mods & files
    const files = (index.files || []).filter((f) => f.env?.server !== 'unsupported');
    const queue = [...files];
    let done = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (queue.length) {
        await fetchPackFile(dir, queue.shift());
        status(`Downloading mods ${++done}/${files.length}...`);
      }
    }));
    // 2. overrides (config, scripts, etc.)
    for (const prefix of ['overrides/', 'server-overrides/']) {
      for (const e of zip.getEntries()) {
        if (e.isDirectory || !e.entryName.startsWith(prefix)) continue;
        const dest = safeJoin(dir, e.entryName.slice(prefix.length));
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest, e.getData());
      }
    }
    // 3. server software
    status('Installing server software...');
    const { json: vj } = await versionJson(mcVer);
    const javaBin = await ensureJava(vj.javaVersion?.majorVersion ?? 8);
    const javaExe = path.join(javaBin, EXE('java'));
    let args, loader = 'vanilla';
    if (deps['fabric-loader']) {
      loader = 'fabric';
      const installers = await getJson('https://meta.fabricmc.net/v2/versions/installer');
      const inst = (installers.find((i) => i.stable) || installers[0]).version;
      await download(`https://meta.fabricmc.net/v2/versions/loader/${mcVer}/${deps['fabric-loader']}/${inst}/server/jar`, path.join(dir, 'fabric-server-launch.jar'));
      args = ['-jar', 'fabric-server-launch.jar', 'nogui'];
    } else if (deps.forge || deps.neoforge) {
      const isNeo = !!deps.neoforge;
      loader = isNeo ? 'neoforge' : 'forge';
      const ver = isNeo ? deps.neoforge : `${mcVer}-${deps.forge}`;
      const url = isNeo
        ? `https://maven.neoforged.net/releases/net/neoforged/neoforge/${ver}/neoforge-${ver}-installer.jar`
        : `https://maven.minecraftforge.net/net/minecraftforge/forge/${ver}/forge-${ver}-installer.jar`;
      await download(url, path.join(dir, 'installer.jar'));
      await runProc(javaExe, ['-jar', 'installer.jar', '--installServer'], dir);
      await fsp.rm(path.join(dir, 'installer.jar'), { force: true });
      const argFile = `libraries/net/${isNeo ? 'neoforged/neoforge' : 'minecraftforge/forge'}/${ver}/${ARGS_FILE}`;
      if (await exists(path.join(dir, argFile))) {
        args = ['@' + argFile, 'nogui'];
      } else {
        const jar = (await fsp.readdir(dir)).find((f) => /^forge-.*\.jar$/.test(f));
        if (!jar) throw new Error('Could not find the installed Forge server.');
        args = ['-jar', jar, 'nogui'];
      }
    } else {
      const serverUrl = vj.downloads?.server?.url;
      if (!serverUrl) throw new Error(`No server download exists for ${mcVer}.`);
      await download(serverUrl, path.join(dir, 'server.jar'));
      args = ['-jar', 'server.jar', 'nogui'];
    }
    // 4. config
    await fsp.writeFile(path.join(dir, 'eula.txt'), 'eula=true\n');
    const propsPath = path.join(dir, 'server.properties');
    let props = (await exists(propsPath)) ? await fsp.readFile(propsPath, 'utf8') : '';
    props = setProp(props, 'server-port', portNum);
    props = setProp(props, 'motd', label.replace(/[\r\n=]/g, ' '));
    await fsp.writeFile(propsPath, props);
    const meta = { id, name: label, mcVersion: mcVer, loader, port: portNum, ramGb: ram, javaExe, args, created: Date.now() };
    await fsp.writeFile(path.join(dir, META_FILE), JSON.stringify(meta, null, 2));
    status('Server ready.');
    return meta;
  } catch (e) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw e;
  }
}

async function listServers() {
  const out = [];
  let names = [];
  try { names = await fsp.readdir(SERVERS_DIR()); } catch { /* none yet */ }
  for (const n of names) {
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(SERVERS_DIR(), n, META_FILE), 'utf8'));
      out.push({ ...meta, running: running.has(meta.id) });
    } catch { /* not a server folder */ }
  }
  return out.sort((a, b) => b.created - a.created);
}

async function startServer(id) {
  if (!validId(id)) throw new Error('Bad server id.');
  if (running.has(id)) return true;
  const dir = path.join(SERVERS_DIR(), id);
  const meta = JSON.parse(await fsp.readFile(path.join(dir, META_FILE), 'utf8'));
  const child = spawn(meta.javaExe, [`-Xmx${meta.ramGb}G`, '-Xms1G', ...meta.args], { cwd: dir, windowsHide: true });
  running.set(id, child);
  const pipe = (s) => s.on('data', (d) => d.toString().split(/\r?\n/).filter(Boolean).forEach((line) => send('server:log', { id, line })));
  pipe(child.stdout); pipe(child.stderr);
  child.on('error', (e) => send('server:log', { id, line: 'Failed to start: ' + e.message }));
  child.on('close', () => { running.delete(id); send('server:state', { id, running: false }); });
  send('server:state', { id, running: true });
  return true;
}

ipcMain.handle('server:list', () => listServers());
ipcMain.handle('server:create', (_e, opts) => createServer(opts || {}));
ipcMain.handle('server:start', (_e, id) => startServer(id));
ipcMain.handle('server:stop', (_e, id) => { running.get(id)?.stdin.write('stop\n'); return true; });
ipcMain.handle('server:command', (_e, { id, cmd }) => {
  const c = String(cmd || '').replace(/[\r\n]/g, ' ').trim();
  if (c) running.get(id)?.stdin.write(c + '\n');
  return true;
});
ipcMain.handle('server:open', (_e, id) => { if (validId(id)) shell.openPath(path.join(SERVERS_DIR(), id)); return true; });
ipcMain.handle('server:delete', async (_e, id) => {
  if (!validId(id)) throw new Error('Bad server id.');
  if (running.has(id)) throw new Error('Stop the server first.');
  await fsp.rm(path.join(SERVERS_DIR(), id), { recursive: true, force: true });
  return true;
});

/* ---------- mod & resource pack store (Modrinth) ---------- */
const LOADERS = ['fabric', 'forge', 'neoforge', 'quilt'];
const validMc = (v) => typeof v === 'string' && /^[A-Za-z0-9._-]{1,32}$/.test(v);
const isPack = (t) => t === 'resourcepack';

async function modsTarget(target, mcVersion, type) {
  if (isPack(type)) {
    if (!validMc(mcVersion)) throw new Error('Pick a Minecraft version.');
    return { dir: path.join(GAME_DIR(), 'resourcepacks'), mcVer: mcVersion, loader: null, ext: '.zip' };
  }
  if (target === 'game') {
    if (!validMc(mcVersion)) throw new Error('Pick a Minecraft version.');
    return { dir: path.join(GAME_DIR(), 'mods'), mcVer: mcVersion, loader: 'fabric', ext: '.jar' };
  }
  if (!validId(target)) throw new Error('Bad target.');
  const meta = JSON.parse(await fsp.readFile(path.join(SERVERS_DIR(), target, META_FILE), 'utf8'));
  if (meta.loader === 'vanilla') throw new Error('This server has no mod loader.');
  return { dir: path.join(SERVERS_DIR(), target, 'mods'), mcVer: meta.mcVersion, loader: meta.loader, ext: '.jar' };
}

async function installMod(projectId, t, seen = new Set(), depth = 0) {
  if (seen.has(projectId)) return [];
  seen.add(projectId);
  let q = `game_versions=${encodeURIComponent(JSON.stringify([t.mcVer]))}`;
  if (t.loader) q += `&loaders=${encodeURIComponent(JSON.stringify([t.loader]))}`;
  const versions = await getJson(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version?${q}`);
  const v = versions[0];
  if (!v) throw new Error(`No build for Minecraft ${t.mcVer}${t.loader ? ' on ' + t.loader : ''}.`);
  const file = v.files.find((f) => f.primary) || v.files[0];
  if (new URL(file.url).hostname !== 'cdn.modrinth.com') throw new Error('Unexpected download host.');
  const name = path.basename(file.filename);
  if (!name.endsWith(t.ext)) throw new Error(`Not a ${t.ext} file.`);
  const buf = await fetchBuffer(file.url);
  if (file.hashes?.sha512 && crypto.createHash('sha512').update(buf).digest('hex') !== file.hashes.sha512) throw new Error('Hash mismatch for ' + name);
  await fsp.mkdir(t.dir, { recursive: true });
  await fsp.writeFile(path.join(t.dir, name), buf);
  const done = [name];
  if (depth < 2 && t.loader) {
    for (const d of v.dependencies || []) {
      if (d.dependency_type === 'required' && d.project_id) {
        try { done.push(...(await installMod(d.project_id, t, seen, depth + 1))); } catch (e) { log('Dependency skipped: ' + e.message); }
      }
    }
  }
  return done;
}

ipcMain.handle('mods:search', async (_e, { query, mcVersion, loader, offset, type }) => {
  const facets = [[`project_type:${isPack(type) ? 'resourcepack' : 'mod'}`]];
  if (validMc(mcVersion)) facets.push([`versions:${mcVersion}`]);
  if (!isPack(type) && LOADERS.includes(loader)) facets.push([`categories:${loader}`]);
  const q = String(query || '').slice(0, 80);
  const url = `https://api.modrinth.com/v2/search?query=${encodeURIComponent(q)}&facets=${encodeURIComponent(JSON.stringify(facets))}&limit=20&offset=${parseInt(offset, 10) || 0}&index=${q ? 'relevance' : 'downloads'}`;
  const j = await getJson(url);
  return j.hits.map((h) => ({ id: h.project_id, title: h.title, desc: h.description, icon: h.icon_url, author: h.author, downloads: h.downloads }));
});
ipcMain.handle('mods:install', async (_e, { projectId, target, mcVersion, type }) => {
  const t = await modsTarget(target, mcVersion, type);
  return installMod(String(projectId), t);
});
ipcMain.handle('mods:list', async (_e, { target, mcVersion, type }) => {
  const t = await modsTarget(target, mcVersion, type);
  try { return (await fsp.readdir(t.dir)).filter((f) => f.endsWith(t.ext)); } catch { return []; }
});
ipcMain.handle('mods:remove', async (_e, { target, mcVersion, file, type }) => {
  const t = await modsTarget(target, mcVersion, type);
  await fsp.rm(path.join(t.dir, path.basename(String(file))), { force: true });
  return true;
});
ipcMain.handle('mods:folder', async (_e, { target, type }) => {
  const dir = isPack(type) ? path.join(GAME_DIR(), 'resourcepacks')
    : target === 'game' ? path.join(GAME_DIR(), 'mods')
    : validId(target) ? path.join(SERVERS_DIR(), target, 'mods') : null;
  if (dir) { await fsp.mkdir(dir, { recursive: true }); shell.openPath(dir); }
  return true;
});

/* ---------- window ---------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 720, minWidth: 900, minHeight: 600,
    backgroundColor: '#0f1115', autoHideMenuBar: true, title: 'Shuben Launcher',
    icon: path.join(__dirname, 'renderer', 'assets', 'logo.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: 'no-user-gesture-required' },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(createWindow);
  app.on('before-quit', () => { for (const c of running.values()) { try { c.stdin.write('stop\n'); } catch { /* ignore */ } } });
  app.on('window-all-closed', () => app.quit());
}
