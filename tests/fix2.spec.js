const {test,expect}=require('@playwright/test');
const clean=page=>page.addInitScript(()=>{if(!sessionStorage.seeded){localStorage.clear();sessionStorage.seeded=1;(localStorage.setItem('cj_onboarded','1'),localStorage.setItem('groq_api_key','gsk_test'))}});
const chat=(page,fn)=>page.route('**/chat/completions',r=>r.fulfill({json:{choices:[{message:{content:typeof fn==='string'?fn:JSON.stringify(fn(r.request().postDataJSON().messages[0].content))}}]}}));
const whisper=(page,text)=>page.route('**/audio/transcriptions',r=>r.fulfill({json:{text}}));
const record=async(page,sel='#rec')=>{await page.click(sel);await expect(page.locator(sel)).toHaveText('Stop');await page.waitForTimeout(600);await page.click(sel)};

test('structured amounts: handful and cups give numbers, v1 vs v2 diff shows',async({page})=>{
  await clean(page);
  let n=0;
  await whisper(page,'a handful of rice, 2 cups water');
  await chat(page,()=>++n===1
    ?{dish:'Rice',ingredients:[{name:'rice',amount:'a handful',unit:''},{name:'water',amount:'2',unit:'cups'},{name:'salt',amount:'a pinch',unit:''}],steps:['Boil']}
    :{dish:'Rice',ingredients:[{name:'Rice',amount:'2',unit:'handfuls'},{name:'water',amount:'2',unit:'cups'},{name:'butter',amount:'a spoon',unit:''}],steps:['Boil']});
  await page.goto('/');
  await record(page);
  await expect(page.locator('#name')).toHaveValue('Rice');
  await page.click('#save');
  const v1=await page.evaluate(async()=>{const db=await import('/js/db.js');return (await db.listVersions((await db.listDishes())[0].id))[0].ingredients});
  expect(v1[0]).toMatchObject({name:'rice',qty_num:30,unit_std:'g',approx:true});   // a handful of rice
  expect(v1[1]).toMatchObject({name:'water',qty_num:480,unit_std:'ml',approx:false}); // 2 cups water
  expect(v1[2]).toMatchObject({qty_num:.4,unit_std:'g',approx:true});               // a pinch
  await expect(page.locator('ul').first()).toContainText('≈30 g');
  await page.goto('/#/');
  await record(page);await page.click('#save');
  await expect(page.locator('h1')).toContainText('v2');
  const d=page.locator('#diff');
  await expect(d).toContainText('~ Rice: ≈30 g → ≈60 g');
  await expect(d).toContainText('+ ≈12 g butter');
  await expect(d).toContainText('− ≈0.4 g salt');
  await expect(d).not.toContainText('water'); // unchanged
});

test('pantry: "cucumber, tomato, and carrot" gives 3 items',async({page})=>{
  await clean(page);
  await whisper(page,'Cucumber, tomato, and carrot.');
  await chat(page,()=>({items:[{name:'cucumber',unsure:false},{name:'tomato',unsure:false},{name:'carrot',unsure:false}]}));
  await page.goto('/#/pantry');await record(page);
  await expect(page.locator('.pchip')).toHaveCount(3);
  await expect(page.locator('#error')).toBeHidden();
  await expect(page.locator('#heard')).toContainText('Cucumber, tomato, and carrot');
});

test('pantry: model reply in the wrong shape or empty no longer drops the list (the real-user bug)',async({page})=>{
  for(const reply of ['{"items":[]}','{"ingredients":["cucumber","tomato","carrot"]}','not json at all','{"items":"cucumber, tomato, carrot"}']){
    const p=await page.context().newPage();
    await clean(p);
    await whisper(p,'Cucumber, tomato, and carrot.');
    await chat(p,reply);
    await p.goto('/#/pantry');await record(p);
    await expect(p.locator('.pchip'),reply).toHaveCount(3);
    await p.close();
  }
});

test('pantry: unsure items are flagged and confirmable; onion/onions merge',async({page})=>{
  await clean(page);
  await whisper(page,'onions, red onion, tomatoe');
  await chat(page,()=>({items:[{name:'onions',unsure:false},{name:'red onion',unsure:false},{name:'tomatoe',unsure:true}]}));
  await page.goto('/#/pantry');
  await page.fill('#pitem','onion');await page.press('#pitem','Enter');
  await record(page);
  await expect(page.locator('.pchip')).toHaveCount(2); // onion absorbed onions + red onion
  await expect(page.locator('.pchip.unsure')).toHaveCount(1);
  await expect(page.locator('.pchip.unsure')).toContainText('tomatoe');
  await expect(page.locator('#heard')).toContainText('onions, red onion, tomatoe');
  await page.click('.pchip.unsure .ok');
  await expect(page.locator('.pchip.unsure')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.pchip.unsure')).toHaveCount(0);
});

test('manifest has id and a maskable icon',async({request})=>{
  const m=await (await request.get('/manifest.webmanifest')).json();
  expect(m.id).toBeTruthy();
  expect(m.icons.some(i=>/maskable/.test(i.purpose||''))).toBe(true);
});
