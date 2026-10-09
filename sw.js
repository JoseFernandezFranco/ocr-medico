// Guarda la app en el móvil para que funcione sin internet. Solo cachea los archivos de la app, nunca datos.
const VERSION = "ocrmed-v5"; // súbela en cada cambio para que los móviles descarguen la versión nueva
const ARCHIVOS = [
  "./", "index.html", "app.js", "extraer.js", "ocr.js", "almacen.js", "camara.js", "variables.yaml", "variables-mama.yaml", "manifest.webmanifest",
  "icono.svg", "icono-180.png", "icono-512.png", "informes-prueba.html",
  "vendor/js-yaml.min.js", "vendor/tesseract.min.js", "vendor/worker.min.js", "vendor/pdf.min.js", "vendor/pdf.worker.min.js",
  "vendor/core/tesseract-core-simd-lstm.wasm.js", "vendor/core/tesseract-core-lstm.wasm.js", "vendor/lang/spa.traineddata.gz",
];

self.addEventListener("install", (e) => {
  // cache: "reload" evita coger copias viejas de la caché HTTP al instalar una versión nueva.
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ARCHIVOS.map((u) => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Primero la caché (funciona sin red); si hay red, variables.yaml se actualiza en segundo plano.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((enCache) => {
      const red = fetch(e.request).then((r) => {
        if (r.ok && e.request.url.endsWith("variables.yaml")) caches.open(VERSION).then((c) => c.put(e.request, r.clone()));
        return r;
      });
      return enCache || red;
    }),
  );
});
