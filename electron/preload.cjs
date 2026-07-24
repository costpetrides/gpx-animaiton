const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('gpxDesktop', {
  isDesktop: true,
  platform: process.platform,
});
