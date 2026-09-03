// Adres ekraninin main surecle konustugu TEK kopru. Bilerek tek islev:
// pencereye acilan yuzey ne kadar dar olursa o kadar iyi.
// Panel penceresine bu preload YUKLENMIYOR (main.js'e bak).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('acPanel', {
    adresKaydet: (adres) => ipcRenderer.invoke('adres-kaydet', adres),
});
