const {test,expect}=require('@playwright/test');
const XSS='<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>';
const seed=page=>page.addInitScript(()=>{if(!sessionStorage.seeded){localStorage.clear();sessionStorage.seeded=1;localStorage.setItem('groq_api_key','gsk_test')}});
const quiet=page=>page.addInitScript(()=>localStorage.setItem('cj_notice_seen','1'));

test('8: CSP present; XSS strings render as text in dish, transcript, pantry',async({page})=>{
  await seed(page);await quiet(page);
  await page.goto('/');
  expect(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')).toContain("connect-src https://api.groq.com");
  const vid=await page.evaluate(async x=>{
    const db=await import('/js/db.js');
    const v=await db.saveVersion({name:x,ingredients:[{name:x,amount:x,unit:x}],steps:[x],transcript:x,parts:[new Blob(['x'],{type:'audio/webm'})]});
    await db.saveAfter(v.id,{rating:3,notes:x,transcript:x,audio:new Blob(['x']),parts:[new Blob(['x'])]});
    return v.id;
  },XSS);
  for(const h of ['#/','#/dish/1','#/version/'+vid]){await page.goto('/'+h);await page.reload();await expect(page.locator('#app')).toContainText('<img src=x');}
  await page.goto('/#/pantry');
  await page.fill('#pitem',XSS.replace(/,/g,' '));await page.click('#padd button');
  await expect(page.locator('#chips')).toContainText('<img');
  expect(await page.locator('#app img, #app script').count()).toBe(0);
  expect(await page.evaluate(()=>window.__xss)).toBeUndefined();
});

test('8: Clear key removes the key',async({page})=>{
  await seed(page);await quiet(page);
  await page.goto('/#/settings');
  await expect(page.locator('#key')).toHaveValue('gsk_test');
  await page.click('#clear-key');
  await expect(page.locator('#key')).toHaveValue('');
  expect(await page.evaluate(()=>localStorage.getItem('groq_api_key'))).toBeNull();
});

test('9: privacy notice shows once; delete recording keeps recipe',async({page})=>{
  await seed(page);
  await page.goto('/');
  await expect(page.locator('#notice')).toContainText('Groq');
  await page.click('#notice-ok');
  await expect(page.locator('#notice')).toBeEmpty();
  await page.reload();
  await expect(page.locator('#notice')).toBeEmpty();
  const vid=await page.evaluate(async()=>{
    const db=await import('/js/db.js');
    return (await db.saveVersion({name:'Soup',ingredients:[{name:'water',amount:'1',unit:'l'}],steps:['Boil'],transcript:'t',parts:[new Blob(['x'],{type:'audio/webm'})]})).id;
  });
  await page.goto('/#/version/'+vid);await page.reload();
  await expect(page.locator('audio')).toHaveCount(1);
  page.once('dialog',d=>d.accept());
  await page.click('#del-audio');
  await expect(page.locator('#audio-gone')).toBeVisible();
  await expect(page.locator('audio')).toHaveCount(0);
  await expect(page.locator('#app')).toContainText('Boil');
  const v=await page.evaluate(async id=>{const db=await import('/js/db.js');const v=await db.getVersion(id);return {a:v.audio,n:v.parts.length}},vid);
  expect(v).toEqual({a:null,n:0});
});

test('11: a new service worker version shows the refresh prompt',async({page},info)=>{
  test.skip(info.project.name!=='mobile','edits sw.js on disk: run once');
  const fs=require('fs'),f=require('path').join(__dirname,'..','sw.js'),orig=fs.readFileSync(f,'utf8');
  try{
    await seed(page);await quiet(page);
    await page.goto('/');
    await page.evaluate(()=>navigator.serviceWorker.ready);
    await expect(page.locator('#update-btn')).toHaveCount(0);   // first install: no prompt
    fs.writeFileSync(f,orig.replace('cj-shell-v6','cj-shell-v7'));   // version bump
    await page.evaluate(()=>navigator.serviceWorker.getRegistration().then(r=>r.update()));
    await expect(page.locator('#update-btn')).toHaveText(/tap to refresh/);
    await page.click('#update-btn');                              // activates the new worker and reloads
    await expect.poll(()=>page.evaluate(()=>caches.keys())).toContain('cj-shell-v7');
  }finally{fs.writeFileSync(f,orig)}
});
