const {test,expect}=require('@playwright/test');
const seed=page=>page.addInitScript(()=>{if(!sessionStorage.seeded){localStorage.clear();sessionStorage.seeded=1;(localStorage.setItem('cj_onboarded','1'),localStorage.setItem('groq_api_key','gsk_test'));localStorage.setItem('cj_notice_seen','1')}});

test('A: import confirms with dates/counts, auto-exports a safety zip, keeps pending',async({page})=>{
  await seed(page);await page.goto('/#/settings');
  await page.evaluate(async()=>{const db=await import('/js/db.js');await db.saveVersion({name:'Old',ingredients:[],steps:['x'],transcript:'t',parts:[new Blob(['x'])]})});
  const [dl]=await Promise.all([page.waitForEvent('download'),page.click('#export')]);
  const old=await dl.path();
  // now: two more dishes and a queued pending session that the old backup does not know about
  await page.evaluate(async()=>{const db=await import('/js/db.js');
    for(const n of ['New1','New2'])await db.saveVersion({name:n,ingredients:[],steps:['x'],transcript:'t',parts:[new Blob(['x'])]});
    const p=await db.createPending({kind:'new',status:'queued'});await db.patchPending(p.id,{parts:[new Blob(['keep-me'])]})});
  const msgs=[];page.on('dialog',d=>{msgs.push(d.message());d.accept()});
  const dlP=page.waitForEvent('download');
  await page.setInputFiles('#import',old);
  const safety=await dlP;
  expect(safety.suggestedFilename()).toMatch(/before-import/);
  await expect.poll(()=>msgs.length).toBe(1);
  expect(msgs[0]).toMatch(/Backup: 1 dishes, 1 sessions, 0 pending/);
  expect(msgs[0]).toMatch(/This device now: 3 dishes, 3 sessions, 1 pending/);
  await expect(page.locator('.card')).toHaveCount(1);
  const r=await page.evaluate(async()=>{const db=await import('/js/db.js');const p=await db.listPending();return {n:p.length,s:p[0]?.status,sz:p[0]?.parts[0]?.size}});
  expect(r).toEqual({n:1,s:'queued',sz:7});
});

test('B: review edits survive a reload',async({page})=>{
  await seed(page);await page.goto('/');
  await page.evaluate(async()=>{const db=await import('/js/db.js');
    await db.saveDraft({name:'Soup',ingredients:[{name:'water',amount:'1',unit:'l'}],steps:['Boil'],transcript:'t',parts:[new Blob(['x'])],long:false,pendingIds:[]})});
  await page.reload();
  await page.goto('/#/review');await page.reload();
  await expect(page.locator('#name')).toHaveValue('Soup');
  await page.fill('#name','Better soup');await page.fill('#steps textarea','Simmer');
  await page.click('#add-ing');await page.locator('#ings .ing').last().locator('input').first().fill('salt');
  await expect.poll(()=>page.evaluate(async()=>{const d=await (await import('/js/db.js')).loadDraft();return d.name+'|'+d.ingredients.length+'|'+d.steps[0]})).toBe('Better soup|2|Simmer');
  await page.reload();
  await expect(page.locator('#name')).toHaveValue('Better soup');
  await expect(page.locator('#steps textarea')).toHaveValue('Simmer');
  await expect(page.locator('#ings .ing')).toHaveCount(2);
  page.on('dialog',d=>d.accept());
  await page.click('#discard');
  await page.goto('/#/review');await page.reload();
  expect(await page.evaluate(async()=>(await import('/js/db.js')).loadDraft())).toBeNull();
  await expect(page.locator('#name')).toHaveCount(0);
});

test('C: Dishes tab hints that rating makes a dish finished',async({page})=>{
  await seed(page);await page.goto('/#/dishes');
  await expect(page.locator('#status-hint')).toContainText('finished');
});
