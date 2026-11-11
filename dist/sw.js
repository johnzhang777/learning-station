const CACHE='listening-station-v11-grade6';
const CORE=['./','./index.html','./styles.css','./app.js','./progress-sync.js','./courses.js','./course-schema.js','./grade5-autumn-data.json','./grade5-spring-data.json','./grade5-autumn-audio-manifest.json','./grade5-spring-audio-manifest.json','./grade6-autumn-data.json','./grade6-spring-data.json','./grade6-autumn-audio-manifest.json','./grade6-spring-audio-manifest.json','./feedback.js','./feedback-auth.js','./checkins.js','./spring-data.json','./spring-audio-manifest.json','./data.json','./audio-manifest.json','./icon.svg','./icon-192.png','./icon-512.png','./manifest.webmanifest'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(CORE)));self.skipWaiting();});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
  const u=new URL(event.request.url);
  if(event.request.method!=='GET'||u.origin!==self.location.origin||u.pathname.includes('/audio/')||(u.pathname.startsWith('/api/')||u.pathname.startsWith('/internal/')||u.pathname.startsWith('/auth/')))return;
  event.respondWith(fetch(event.request).then(response=>{
    if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy));}
    return response;
  }).catch(()=>caches.match(event.request).then(cached=>cached||Response.error())));
});
