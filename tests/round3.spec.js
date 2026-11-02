const {test,expect}=require('@playwright/test');
const fresh=(page,key=true)=>page.addInitScript(k=>{if(!sessionStorage.seeded){localStorage.clear();sessionStorage.seeded=1;localStorage.setItem('cj_notice_seen','1');
  if(k){localStorage.setItem('cj_onboarded','1');localStorage.setItem('groq_api_key','gsk_test')}}},key);
const ai=(page,out)=>page.route('**/chat/completions',r=>r.fulfill({json:{choices:[{message:{content:JSON.stringify(out||{dish:'Soup',ingredients:[{name:'salt',amount:'some',unit:'sprinkles'}],steps:['Stir']})}}]}}));
const mkVers=(page,list)=>page.evaluate(async list=>{
  const db=await import('/js/db.js');let dishId;
  for(const [rating,ings] of list){
    const v=await db.saveVersion({name:'Machboos',ingredients:ings.map(name=>({name,amount:'1',unit:''})),steps:['Boil '.repeat(30)],transcript:'t',parts:[new Blob(['x'])]});
    dishId=v.dishId;if(rating)await db.saveAfter(v.id,{rating,notes:'n',transcript:'t',parts:[]});
  }
  return dishId;
},list);

test('1: why card diffs against latest RATED version below the best',async({page})=>{
  await fresh(page);await page.goto('/');
  const id=await mkVers(page,[[3,['rice','onion']],[0,['rice','garlic']],[5,['rice','onion','saffron']]]);
  await page.goto('/#/dish/'+id);
  await expect(page.locator('#why')).toContainText('Why was v3 better');
  await expect(page.locator('#why')).toContainText('v1 got');       // compared with v1, not the unrated v2
  await expect(page.locator('#why-diff')).toContainText('saffron');
  await expect(page.locator('#why-diff')).not.toContainText('garlic');
  // fallback: nothing rated below -> n-1
  const id2=await page.evaluate(async()=>{const db=await import('/js/db.js');
    await db.saveVersion({name:'B',ingredients:[{name:'a',amount:'1',unit:''}],steps:[],transcript:'',parts:[new Blob(['x'])]});
    const v=await db.saveVersion({name:'B',ingredients:[{name:'a',amount:'1',unit:''},{name:'b',amount:'1',unit:''}],steps:[],transcript:'',parts:[new Blob(['x'])]});
    await db.saveAfter(v.id,{rating:4,notes:'',transcript:'',parts:[]});return v.dishId});
  await page.goto('/#/dish/'+id2);
  await expect(page.locator('#why')).toContainText('v1 was not rated');
});

test('2: model ids live in config.js; retired model gives a clear message (text, whisper, vision)',async({page})=>{
  await fresh(page);
  const gone=r=>r.fulfill({status:400,json:{error:{message:'The model has been decommissioned',code:'model_decommissioned'}}});
  await page.goto('/');
  const cfg=await page.evaluate(async()=>{const c=await import('/js/config.js');return Object.keys(c)});
  expect(cfg).toEqual(expect.arrayContaining(['TEXT_MODELS','WHISPER_MODEL','VISION_MODEL']));
  await page.route('**/audio/transcriptions',gone);
  await page.click('#rec');await page.waitForTimeout(500);await page.click('#rec');
  await expect(page.locator('#error')).toContainText('AI model unavailable, update config');
  await page.unroute('**/audio/transcriptions');
  await page.route('**/chat/completions',r=>r.fulfill({status:404,json:{error:{message:'model_not_found'}}}));
  await page.click('#m-type');await page.fill('#typed','I made soup');await page.click('#typed-go');
  await expect(page.locator('#error')).toContainText('AI model unavailable, update config');
  const msgs=await page.evaluate(async()=>{const g=await import('/js/groq.js');
    try{await g.readReceipt({images:['data:image/png;base64,AAAA']})}catch(e){return e.message}});
  expect(msgs).toContain('AI model unavailable, update config');
});

test('3: "Cook latest" until a version is rated, then "Cook my best version"',async({page})=>{
  await fresh(page);await page.goto('/');
  const id=await mkVers(page,[[0,['rice']]]);
  await page.goto('/#/dish/'+id);
  await expect(page.locator('#cook-best')).toHaveText(/Cook latest/);
  await page.evaluate(async()=>{const db=await import('/js/db.js');const v=(await db.listVersions(1))[0];await db.saveAfter(v.id,{rating:4,notes:'',transcript:'',parts:[]})});
  await page.reload();
  await expect(page.locator('#cook-best')).toHaveText(/Cook my best/);
});

test('4+5: marks in "Add to this dish" are offset; vague units keep her words; buttons >= 64px',async({page})=>{
  await fresh(page);
  await page.route('**/audio/transcriptions',r=>r.fulfill({json:{text:'some sprinkles of salt'}}));
  await ai(page);await page.goto('/');
  const id=await page.evaluate(async()=>{const db=await import('/js/db.js');
    const v=await db.saveVersion({name:'Soup',ingredients:[],steps:['x'],transcript:'t',parts:[new Blob(['x'])],secs:60});return v.id});
  await page.goto('/#/version/'+id);
  await page.click('#add-more');await expect(page.locator('#add-more')).toHaveText('Stop');
  for(const sel of ['#add-more','.pause','.mark']){const b=await page.locator(sel).first().boundingBox();expect(b.width,sel).toBeGreaterThanOrEqual(63.5);expect(b.height,sel).toBeGreaterThanOrEqual(63.5)}
  await page.waitForTimeout(1200);await page.click('.mark');
  await page.click('#add-more');
  await expect(page.locator('#marks li')).toHaveCount(1);
  await expect(page.locator('#marks li b')).toHaveText(/^1:0[1-9]$/); // 60s earlier recording + ~1s
  await expect(page.locator('ul').first()).toContainText('some sprinkles salt');
  await expect(page.locator('ul').first()).not.toContainText('≈1');
  const t=await page.evaluate(async()=>{const a=await import('/js/amounts.js');
    return [a.say(a.enrich({name:'x',amount:'some',unit:'sprinkles'})),a.fmtQty(a.enrich({name:'x',amount:'some',unit:'sprinkles'})),a.say(a.enrich({name:'x',amount:'2',unit:'cups'}))]});
  expect(t).toEqual(['some sprinkles','','≈480 ml'.replace('≈','')]);
});

test('Whisper prompt has Omani dish names',async({page})=>{
  await fresh(page);let body='';
  await page.route('**/audio/transcriptions',r=>{body=r.request().postData();r.fulfill({json:{text:'rice'}})});
  await ai(page);await page.goto('/');
  await page.click('#rec');await page.waitForTimeout(500);await page.click('#rec');
  await expect.poll(()=>body).toBeTruthy();
  for(const w of ['madrouba','mishaltit','mkhalif','qabooli','thareed','saloona'])expect(body).toContain(w);
});

test('onboarding: 3 skippable screens, once; key saved; test recording shows transcript',async({page})=>{
  await fresh(page,false);
  await page.addInitScript(()=>{window.CJ_ONBOARD_SECS=2});
  await page.route('**/audio/transcriptions',r=>r.fulfill({json:{text:'I am cooking rice'}}));
  await page.goto('/');
  const link=page.locator('#ob-link');
  await expect(link).toHaveText('Get free AI key');
  await expect(link).toHaveAttribute('href','https://console.groq.com/keys');
  await expect(page.locator('.onb')).not.toContainText(/groq|grok/i);
  await page.fill('#ob-key','gsk_abc');await page.click('#ob-save');
  await expect(page.locator('#ob-saved')).toHaveText('Saved.');
  expect(await page.evaluate(()=>localStorage.getItem('groq_api_key'))).toBe('gsk_abc');
  await page.click('#ob-next');
  await expect(page.locator('.onb')).toContainText('Add to Home Screen');
  await expect(page.locator('.onb')).toContainText('Share');
  await page.click('#ob-next');
  await page.click('#ob-rec');await expect(page.locator('#ob-rec')).toHaveText('Stop');
  await expect(page.locator('#ob-transcript')).toContainText('I am cooking rice',{timeout:8000}); // auto-stops after the short test window
  await page.click('#ob-next');
  await expect(page.locator('.onb')).toHaveCount(0);
  await page.reload();await expect(page.locator('.onb')).toHaveCount(0);
});
test('onboarding: Skip on the first screen closes it for good',async({page})=>{
  await fresh(page,false);await page.goto('/');
  await expect(page.locator('.onb')).toBeVisible();
  await page.click('#ob-skip');await expect(page.locator('.onb')).toHaveCount(0);
  await page.reload();await expect(page.locator('.onb')).toHaveCount(0);
});

test('monthly backup reminder: shows when never/over 30 days, one-tap export, badge once',async({page})=>{
  await fresh(page);await page.goto('/');
  await expect(page.locator('#backup-banner')).toHaveCount(0);          // no data, nothing to lose
  await mkVers(page,[[0,['rice']]]);
  await page.goto('/#/dishes');
  await expect(page.locator('#backup-banner')).toContainText('never made a backup');
  const [dl]=await Promise.all([page.waitForEvent('download'),page.click('#backup-go')]);
  expect(dl.suggestedFilename()).toMatch(/^cooking-journal-.*\.zip$/);
  await expect(page.locator('#backup-banner')).toHaveCount(0);
  expect(+await page.evaluate(()=>localStorage.cj_last_export)).toBeGreaterThan(0);
  expect(await page.evaluate(()=>JSON.parse(localStorage.cj_game).badges)).toContain('backup');
  await page.goto('/#/me');await expect(page.locator('#app').getByText('Backup keeper')).toBeVisible();
  await page.evaluate(()=>localStorage.cj_last_export=String(Date.now()-10*864e5));
  await page.goto('/#/dishes');await page.reload();await expect(page.locator('#backup-banner')).toHaveCount(0);
  await page.evaluate(()=>localStorage.cj_last_export=String(Date.now()-31*864e5));
  await page.reload();await expect(page.locator('#backup-banner')).toContainText('31 days ago');
});

test('Arabic name: editable, shown rtl and escaped; share card shares or downloads a PNG',async({page})=>{
  await fresh(page);await page.goto('/');
  const id=await mkVers(page,[[4,['rice','onion']]]);
  await page.goto('/#/dish/'+id);
  await expect(page.locator('#ar-show')).toHaveCount(0);
  await page.fill('#ar-name','مجبوس <b>x</b>');await page.click('#ar-save');
  const ar=page.locator('#ar-show');
  await expect(ar).toHaveAttribute('dir','rtl');await expect(ar).toContainText('مجبوس <b>x</b>');
  await page.reload();await expect(ar).toContainText('مجبوس');
  await page.goto('/#/dishes');await expect(page.locator('.dishcard .ar')).toHaveAttribute('dir','rtl');
  await page.goto('/#/dish/'+id);
  // download fallback
  await page.evaluate(()=>{Object.defineProperty(navigator,'canShare',{value:undefined,configurable:true})});
  const [dl]=await Promise.all([page.waitForEvent('download'),page.click('#share-card')]);
  expect(dl.suggestedFilename()).toMatch(/\.png$/);
  const fs=require('fs'),buf=fs.readFileSync(await dl.path());
  expect(buf.slice(1,4).toString()).toBe('PNG');expect(buf.length).toBeGreaterThan(5000);
  // navigator.share with files
  await page.evaluate(()=>{window.__s=null;Object.defineProperty(navigator,'canShare',{value:o=>!!o.files,configurable:true});
    Object.defineProperty(navigator,'share',{value:async o=>{window.__s={n:o.files[0].name,t:o.files[0].type,sz:o.files[0].size}},configurable:true})});
  await page.click('#share-card');
  await expect.poll(()=>page.evaluate(()=>window.__s)).toMatchObject({t:'image/png',n:/Machboos\.png/.source&&expect.stringContaining('Machboos')});
});
