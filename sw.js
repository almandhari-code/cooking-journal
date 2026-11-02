const CACHE='cj-shell-v9';
const SHELL=['./','index.html','styles.css','app.js','js/db.js','js/groq.js','js/recorder.js','js/ui.js','js/game.js','js/sound.js','js/fx.js','js/chart.js','js/pantry.js','js/data.js','js/zip.js','js/amounts.js','js/receipt.js','js/insight.js','js/config.js','manifest.webmanifest','icons/icon-192.png','icons/icon-512.png','icons/icon-maskable-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)))});
self.addEventListener('message',e=>{if(e.data==='SKIP_WAITING')self.skipWaiting()}); // the page asks once the user taps refresh
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==CACHE).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==location.origin)return; // never cache API calls
  e.respondWith(fetch(e.request).catch(()=>caches.match(e.request)));
});
