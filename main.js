// QWIZERO Studio — главный процесс Electron
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#14141a',
    title: 'QWIZERO Studio',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);
  win.maximize();
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ---------- Файловые диалоги ----------
ipcMain.handle('save-file', async (e, { data, defaultPath, filters }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath, filters });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, Buffer.from(data));
  return r.filePath;
});

ipcMain.handle('open-file', async (e, { filters }) => {
  const r = await dialog.showOpenDialog(win, { filters, properties: ['openFile'] });
  if (r.canceled || !r.filePaths.length) return null;
  const p = r.filePaths[0];
  return { name: path.basename(p), data: new Uint8Array(fs.readFileSync(p)) };
});

// ---------- Экспорт MP4 через ffmpeg ----------
function ffmpegPath() {
  let p = require('ffmpeg-static');
  if (p && p.includes('app.asar')) p = p.replace('app.asar', 'app.asar.unpacked');
  return p;
}

ipcMain.handle('mp4-begin', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwizero-'));
  return dir;
});

ipcMain.handle('mp4-frame', async (e, { dir, index, bytes }) => {
  const name = 'f_' + String(index).padStart(5, '0') + '.png';
  fs.writeFileSync(path.join(dir, name), Buffer.from(bytes));
  return true;
});

ipcMain.handle('mp4-finish', async (e, { dir, fps, defaultPath }) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath,
    filters: [{ name: 'MP4 видео', extensions: ['mp4'] }]
  });
  if (r.canceled || !r.filePath) { cleanup(dir); return null; }
  const ff = ffmpegPath();
  if (!ff || !fs.existsSync(ff)) { cleanup(dir); throw new Error('ffmpeg не найден'); }
  await new Promise((resolve, reject) => {
    const pr = spawn(ff, [
      '-y', '-framerate', String(fps),
      '-i', path.join(dir, 'f_%05d.png'),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18',
      r.filePath
    ]);
    pr.on('exit', c => c === 0 ? resolve() : reject(new Error('ffmpeg завершился с кодом ' + c)));
    pr.on('error', reject);
  });
  cleanup(dir);
  return r.filePath;
});

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}
