const {test,expect}=require('@playwright/test');
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.join(__dirname,'..'),MIME={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.png':'image/png','.webmanifest':'application/manifest+json'};

test('works when served under /cooking-journal/ (GitHub Pages): SW scope, manifest, pdf.js, no 404s',async({page})=>{
  const srv=http.createServer((q,s)=>{
    const u=decodeURIComponent(q.url.split('?')[0]);
    if(!u.startsWith('/cooking-journal/')){s.statusCode=404;return s.end()}
    let f=path.join(ROOT,u.slice('/cooking-journal/'.length)||'index.html');
    if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){s.statusCode=404;return s.end()}
    s.setHeader('Content-Type',MIME[path.extname(f)]||'application/octet-stream');s.end(fs.readFileSync(f));
  });
  await new Promise(r=>srv.listen(0,r));
  const base=`http://localhost:${srv.address().port}/cooking-journal/`;
  const bad=[];page.on('response',r=>{if(r.status()>=400)bad.push(r.status()+' '+r.url())});
  try{
    await page.goto(base);
    await expect(page.locator('#tabs')).toBeVisible();
    const reg=await page.evaluate(async()=>{const r=await navigator.serviceWorker.ready;return {scope:r.scope,script:r.active.scriptURL}});
    expect(reg.scope).toBe(base);expect(reg.script).toBe(base+'sw.js');
    const m=await (await page.request.get(base+'manifest.webmanifest')).json();
    expect(new URL(m.start_url,base+'manifest.webmanifest').href).toBe(base);
    expect(new URL(m.scope,base+'manifest.webmanifest').href).toBe(base);
    expect(new URL(m.id,base+'manifest.webmanifest').href).toBe(base);
    for(const i of m.icons)expect((await page.request.get(base+i.src)).status()).toBe(200);
    // every shell file listed in the SW is cached under the subpath
    const cached=await page.evaluate(async()=>{const c=await caches.keys();const k=await (await caches.open(c[0])).keys();return k.map(r=>r.url)});
    expect(cached).toContain(base);expect(cached).toContain(base+'js/receipt.js');
    expect(cached.every(u=>u.startsWith(base))).toBe(true);
    // pdf.js loads from the vendor folder under the subpath
    await page.goto(base+'#/pantry');
    const ok=await page.evaluate(async()=>{const m=await import('./js/receipt.js');return typeof m.readPdf});
    expect(ok).toBe('function');
    expect((await page.request.get(base+'vendor/pdfjs/pdf.worker.min.mjs')).status()).toBe(200);
    expect(bad.filter(x=>!/favicon/.test(x))).toEqual([]);
  }finally{srv.close()}
});

test('no absolute-root paths in the shipped files',()=>{
  for(const f of ['index.html','manifest.webmanifest','sw.js','app.js']){
    const s=fs.readFileSync(path.join(ROOT,f),'utf8');
    expect(s,f).not.toMatch(/(?:href|src|start_url|scope|register\()\s*[=:]?\s*["']\/[a-z]/i);
  }
});
