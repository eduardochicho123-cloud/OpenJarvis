// Reemplaza el service worker de la SPA original de OpenJarvis (Workbox,
// con precache agresivo) -- por eso algunos navegadores seguian sirviendo
// la interfaz vieja aunque el servidor ya tenia el Command Center nuevo.
// Este archivo se autodestruye: borra todos los caches, se desregistra a
// si mismo, y fuerza a que la pagina se sirva siempre directo del servidor.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      await self.registration.unregister();
      const clientsList = await self.clients.matchAll({ type: 'window' });
      clientsList.forEach((client) => client.navigate(client.url));
    })(),
  );
});
