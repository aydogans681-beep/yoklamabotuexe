// Renderer (pencere içi HTML) ile main süreç arasındaki güvenli köprü.
// contextIsolation açık; renderer'a sadece bu üç fonksiyon açılır.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    durum: () => ipcRenderer.invoke('durum'),
    kaydet: (govde) => ipcRenderer.invoke('kaydet', govde),
    tara: (link) => ipcRenderer.invoke('tara', link),
});
