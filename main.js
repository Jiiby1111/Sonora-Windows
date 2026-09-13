const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const mm = require('music-metadata');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#161616',
    title: 'Sonora',
    frame: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('select-folder', async (event, folderArg) => {
  let folder = folderArg;
  if (!folder) {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    folder = result.filePaths[0];
  }
  return scanFolder(folder);
});

ipcMain.on('window-minimize', () => mainWindow.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window-close', () => mainWindow.close());

ipcMain.on('app-notify', (event, message, type) => {
  if (Notification.isSupported()) {
    const notif = new Notification({ title: 'Sonora', body: message });
    notif.show();
  }
});

ipcMain.on('app-reveal', (event, filePath) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle('read-audio-file', async (event, filePath) => {
  try {
    const buf = fs.readFileSync(filePath);
    // Copy into an ArrayBuffer so the transfer is clean across context bridge
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return ab;
  } catch (e) {
    return null;
  }
});

const SUPPORTED = ['.mp3', '.m4a', '.flac', '.wav', '.ogg', '.aac', '.wma', '.opus', '.webm', '.mp4'];

async function scanFolder(folder) {
  const files = [];

  function walk(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED.includes(ext)) files.push(full);
      }
    }
  }

  walk(folder);

  const songs = [];
  for (const full of files) {
    const stats = fs.statSync(full);
    const base = {
      path: full,
      name: path.basename(full, path.extname(full)),
      folder: path.basename(path.dirname(full)),
      size: stats.size
    };
    try {
      const meta = await mm.parseFile(full, { duration: true, skipCovers: false });
      const common = meta.common || {};
      const format = meta.format || {};
      let cover = null;
      if (common.picture && common.picture.length) {
        const pic = common.picture[0];
        cover = 'data:' + (pic.format || 'image/jpeg') + ';base64,' + pic.data.toString('base64');
      }
      songs.push({
        ...base,
        title: common.title || base.name,
        artist: (common.artist || common.albumartist || 'Unknown Artist'),
        album: common.album || base.folder,
        year: common.year || null,
        genre: (common.genre || [''])[0] || '',
        duration: Math.round(format.duration || 0),
        bitrate: format.bitrate || 0,
        sampleRate: format.sampleRate || 0,
        codec: format.codec || path.extname(full).slice(1).toUpperCase(),
        cover
      });
    } catch (e) {
      songs.push(base);
    }
  }

  return { folder, songs };
}