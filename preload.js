// QWIZERO Studio — мост между окном и системой
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qwizero', {
  saveFile: (opts) => ipcRenderer.invoke('save-file', opts),
  openFile: (opts) => ipcRenderer.invoke('open-file', opts),
  mp4Begin: () => ipcRenderer.invoke('mp4-begin'),
  mp4Frame: (dir, index, bytes) => ipcRenderer.invoke('mp4-frame', { dir, index, bytes }),
  mp4Finish: (opts) => ipcRenderer.invoke('mp4-finish', opts)
});
