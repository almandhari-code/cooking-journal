const {test,expect}=require('@playwright/test');
require('fs').mkdirSync(process.env.SHOTS_DIR||'test-results/screenshots',{recursive:true});

async function mock(page,log){
  await page.route('**/audio/transcriptions',r=>r.fulfill({json:{text:'I have rice, onions and some saffron'}}));
  await page.route('**/chat/completions',r=>{
    const b=r.request().postDataJSON();log.chat.push(b);
    const sys=b.messages[0].content;
    const out=/"items"/.test(sys)?{items:['rice','Onions','saffron']}
      :/"ideas"/.test(sys)?{ideas:[{name:'Saffron rice',why:'Simple and fragrant.',missing:['butter']},{name:'Onion soup',why:'Cozy.',missing:['stock','bread']}]}
      :{dish:'x',ingredients:[],steps:[]};
    r.fulfill({json:{choices:[{message:{content:JSON.stringify(out)}}]}});
  });
}
const clean=page=>page.addInitScript(()=>{if(!sessionStorage.seeded){localStorage.clear();sessionStorage.seeded=1;(localStorage.setItem('cj_onboarded','1'),localStorage.setItem('groq_api_key','gsk_test'))}});
const seed=page=>page.evaluate(async()=>{
  const db=await import('/js/db.js'),b=()=>new Blob(['x'],{type:'audio/webm'});
  const mk=async(name,ings,r)=>{const v=await db.saveVersion({name,ingredients:ings.map(name=>({name,amount:'1',unit:''})),steps:['Cook'],transcript:'t',parts:[b()]});
    if(r)await db.saveAfter(v.id,{rating:r,notes:'n',transcript:'t',audio:b(),parts:[b()]});return v};
  await mk('Machboos',['rice','onion','chicken','bzar'],3);   // older, lower rated
  await mk('Machboos',['rice','onion','saffron'],5);          // best version: fits
  await mk('Harees',['wheat','meat','ghee','cinnamon','salt'],4); // too many missing
  await mk('Rice and onion',['Red Onions','rice','water'],0); // plural/partial match, staple ignored
});

test('type, dedupe, remove, persist',async({page})=>{
  await clean(page);await mock(page,{chat:[]});await page.goto('/#/pantry');
  await expect(page.locator('#cook')).toBeDisabled();
  await page.fill('#pitem','Rice, onions');await page.press('#pitem','Enter');
  await page.fill('#pitem','rice');await page.press('#pitem','Enter'); // duplicate
  await expect(page.locator('.pchip')).toHaveCount(2);
  await page.reload();
  await expect(page.locator('.pchip')).toHaveCount(2);
  await page.click('.pchip >> nth=0 >> .x');
  await expect(page.locator('.pchip')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('.pchip')).toHaveCount(1);
});

test('voice adds items (deduped) via Whisper + LLM',async({page})=>{
  await clean(page);const log={chat:[]};await mock(page,log);await page.goto('/#/pantry');
  await page.fill('#pitem','rice');await page.press('#pitem','Enter');
  await page.click('#rec');await expect(page.locator('#rec')).toHaveText('Stop');
  await page.waitForTimeout(600);await page.click('#rec');
  await expect(page.locator('.pchip')).toHaveCount(3);
  await expect(page.locator('#chips')).toContainText('Onions');
  expect(await page.evaluate(()=>JSON.parse(localStorage.cj_pantry))).toEqual(['rice','Onions','saffron']);
});

test('what can I cook: best version first, missing shown, then LLM ideas',async({page})=>{
  const log={chat:[]};
  await clean(page);await mock(page,log);await page.goto('/');await seed(page);
  await page.evaluate(()=>localStorage.setItem('cj_pantry',JSON.stringify(['rice','onions','saffron','chicken'])));
  await page.goto('/#/pantry');await page.click('#cook');
  const fit=page.locator('.card.fit');
  await expect(fit).toHaveCount(2);
  await expect(fit.nth(0)).toContainText('Machboos');
  await expect(fit.nth(0)).toContainText('v2');          // best-rated version, not v1
  await expect(fit.nth(0)).toContainText('You have everything');
  await expect(fit.nth(1)).toContainText('Rice and onion'); // Red Onions ~ onions, water ignored
  await expect(page.locator('.card.fit', {hasText:'Harees'})).toHaveCount(0); // 4 missing
  await expect(page.locator('.card.idea')).toHaveCount(2);
  await expect(page.locator('.card.idea').nth(1)).toContainText('stock, bread');
  const req=log.chat.at(-1);
  expect(req.messages[1].content).toContain('Machboos'); // known dishes passed to the LLM
  expect(req.messages[1].content).toContain('saffron');
});

test('missing ingredients shown for near-fit dish; ideas error keeps saved results',async({page})=>{
  await clean(page);await page.addInitScript(()=>{window.CJ_MAX_TRIES=1}); // no backoff wait, check the final error
  await page.route('**/chat/completions',r=>r.fulfill({status:429,json:{error:{message:'slow down'}}}));
  await page.goto('/');await seed(page);
  await page.evaluate(()=>localStorage.setItem('cj_pantry',JSON.stringify(['rice','onion'])));
  await page.goto('/#/pantry');await page.click('#cook');
  await expect(page.locator('.card.fit',{hasText:'Machboos'})).toContainText('Missing: saffron'); // v2 needs saffron
  await expect(page.locator('#cook-out')).toContainText('rate limit');
});

test('tab bar links to pantry; screenshots',async({page},info)=>{
  await clean(page);await mock(page,{chat:[]});await page.goto('/');await seed(page);
  await page.evaluate(()=>localStorage.setItem('cj_pantry',JSON.stringify(['rice','onions','saffron','chicken','tomatoes','lemon'])));
  await page.reload();
  await page.click('#tab-pantry');
  await expect(page).toHaveURL(/#\/pantry/);
  await expect(page.locator('#chips .pchip')).toHaveCount(6);
  if(info.project.name!=='mobile')return;
  await page.screenshot({path:(process.env.SHOTS_DIR||'test-results/screenshots')+'/pantry.png'});
  await page.click('#cook');
  await expect(page.locator('.card.idea')).toHaveCount(2);
  await page.screenshot({path:(process.env.SHOTS_DIR||'test-results/screenshots')+'/pantry-results.png',fullPage:true});
  await page.click('#rec');await page.waitForTimeout(1200);
  await page.screenshot({path:(process.env.SHOTS_DIR||'test-results/screenshots')+'/pantry-recording.png'});
});
