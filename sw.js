// Service worker — permet à l'application de s'ouvrir même sans connexion
// internet (l'écran et le code de l'app sont mis en cache). Les données
// elles-mêmes viennent de Supabase et sont gérées séparément par le cache
// hors-ligne de l'application (voir src/js/app.js).
const CACHE_NAME = 'lakouwon-shell-v3';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './src/config.js',
  './src/js/app.js',
  './src/js/events.js',
  './src/js/views.js',
  './src/js/supabaseClient.js',
  './src/js/vendor/supabase.esm.js',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase, polices, etc. : pas notre rôle

  // Réseau en premier : l'app est mise à jour souvent, donc on veut toujours
  // la dernière version quand internet est disponible. Le cache ne sert que
  // de secours quand la requête réseau échoue (vraiment hors-ligne).
  event.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req))
  );
});
