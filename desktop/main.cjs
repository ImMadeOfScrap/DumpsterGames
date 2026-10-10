'use strict';
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const net = require('net');

let mainWindow = null;
let gameServer = null;
let gameIo = null;
let gamePort = 0;

function chooseFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function ensurePortAvailable(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(new Error(`Local game port ${port} is already in use. Close another copy of Dumpster Divers and try again.`)));
    probe.listen(port, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolve()));
  });
}
async function waitForGameServer() {
  const healthUrl = `http://127.0.0.1:${gamePort}/api/health`;
  let lastError;
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return;
    } catch (e) { lastError = e; }
    await sleep(250);
  }
  throw new Error(`Dumpster Divers could not start its local game server. ${lastError ? lastError.message : ''}`);
}
async function createWindow() {
  // Keep a stable origin so login sessions persist between launches.
  gamePort = 34123;
  await ensurePortAvailable(gamePort);
  process.env.PORT = String(gamePort);
  process.env.HOST = '127.0.0.1';
  process.env.DD_DATA_DIR = path.join(app.getPath('userData'), 'save-data');
  process.env.DD_SINGLE_PLAYER = '1';

  const gameModule = require(path.join(__dirname, 'game', 'server.js'));
  gameServer = gameModule.server;
  gameIo = gameModule.io;
  await waitForGameServer();

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 650,
    backgroundColor: '#11141d',
    autoHideMenuBar: true,
    title: 'Dumpster Divers',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://127.0.0.1:${gamePort}/`)) return { action: 'allow' };
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  await mainWindow.loadURL(`http://127.0.0.1:${gamePort}`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(createWindow).catch(error => {
  console.error(error);
  const { dialog } = require('electron');
  dialog.showErrorBox('Dumpster Divers could not start', `${error.message}\n\nTry reinstalling the app. Your local save folder is preserved.`);
  app.quit();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow().catch(console.error); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  try { if (gameIo) gameIo.close(); else if (gameServer?.listening) gameServer.close(); } catch {}
});
