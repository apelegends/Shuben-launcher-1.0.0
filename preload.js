'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const EVENTS = ['log', 'status', 'progress', 'game:closed', 'server:log', 'server:state'];

contextBridge.exposeInMainWorld('api', {
  login: invoke('auth:login'),
  quit: invoke('app:quit'),
  demoLogin: invoke('auth:demo'),
  autoLogin: invoke('auth:auto'),
  logout: invoke('auth:logout'),
  getProfile: invoke('profile:get'),
  listVersions: invoke('versions:list'),
  launch: invoke('game:launch'),
  listAccounts: invoke('acc:list'),
  addOffline: invoke('acc:add'),
  removeOffline: invoke('acc:remove'),
  searchMods: invoke('mods:search'),
  installMod: invoke('mods:install'),
  listMods: invoke('mods:list'),
  removeMod: invoke('mods:remove'),
  openModsFolder: invoke('mods:folder'),
  uploadSkin: invoke('skin:upload'),
  setCape: invoke('cape:set'),
  listServers: invoke('server:list'),
  createServer: invoke('server:create'),
  startServer: invoke('server:start'),
  stopServer: invoke('server:stop'),
  serverCommand: invoke('server:command'),
  openServerFolder: invoke('server:open'),
  deleteServer: invoke('server:delete'),
  on: (channel, cb) => {
    if (EVENTS.includes(channel)) ipcRenderer.on(channel, (_e, payload) => cb(payload));
  },
});
