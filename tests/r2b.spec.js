const {test,expect}=require('@playwright/test');
const clean=page=>page.addInitScript(()=>{if(!sessionStorage.seeded){localStorage.clear();sessionStorage.seeded=1;localStorage.setItem('groq_api_key','gsk_test')}});
const ai=(page,log,out)=>page.route('**/chat/completions',r=>{const b=r.request().postDataJSON();log.push(b);
  r.fulfill({json:{choices:[{message:{content:JSON.stringify(/better/.test(b.messages[0].content)?{sentence:'More saffron made it richer.'}:out||{dish:'Machboos',ingredients:[{name:'rice',amount:'2',unit:'cups'},{name:'saffron',amount:'1',unit:'pinch'}],steps:['Boil']})}}]}})});
const seed=page=>page.evaluate(async()=>{
  const db=await import('/js/db.js'),bl=()=>new Blob(['x']);
  const a=await db.saveVersion({name:'Machboos',ingredients:[{name:'rice',amount:'2',unit:'cups'},{name:'onion',amount:'1',unit:''}],steps:['Boil'],transcript:'t',parts:[bl()]});
  const b=await db.saveVersion({name:'Machboos',ingredients:[{name:'rice',amount:'3',unit:'cups'},{name:'saffron',amount:'1',unit:'pinch'}],steps:['Boil','Rest <b>x</b>'],transcript:'t',parts:[bl()]});
  const put=async(id,after)=>{const v=await db.getVersion(id);v.after=after;await db.patchVersion(id,{after})};
  await put(a.id,{rating:2,notes:'Too bland, less salt'});await put(b.id,{rating:5,notes:'Loved it <i>x</i>'});
  return b.dishId;
});
test('F1+F2+F4: why card (cached AI), cook checklist, last-note banner',async({page})=>{
  const log=[];await clean(page);await ai(page,log);await page.goto('/');
  const id=await seed(page);
  await page.evaluate(()=>localStorage.setItem('cj_pantry',JSON.stringify(['Rice','onions'])));
  await page.goto('/#/dish/'+id);
  await expect(page.locator('#why')).toContainText('Why was v2 better');
  await expect(page.locator('#why-diff')).toContainText('+ ≈0.4 g saffron');
  await expect(page.locator('#why-diff')).toContainText('rice: 480 ml → 720 ml');
  await expect(page.locator('#why-note')).toContainText('Loved it <i>x</i>');
  await expect(page.locator('#why-ai')).toHaveText('More saffron made it richer.');
  await page.reload();await expect(page.locator('#why-ai')).toHaveText('More saffron made it richer.');
  expect(log.filter(b=>/better/.test(b.messages[0].content)).length).toBe(1); // cached
  await page.click('#cook-best');
  await expect(page.locator('#cl-ings li')).toHaveCount(2);
  await expect(page.locator('#cook-miss')).toContainText('saffron');
  await expect(page.locator('#cl-ings li.lack')).toHaveCount(1);
  await expect(page.locator('#cl-ings')).toContainText('720 ml');
  await expect(page.locator('#cl-steps li')).toHaveCount(2);
  // F4 via New version
  await page.goto('/#/dish/'+id);await page.click('#new-ver');
  await expect(page.locator('#newfor')).toContainText('Machboos');
  await expect(page.locator('#lastnote')).toContainText('Loved it');
  // F4 via typing the dish name
  await page.goto('/');await page.click('#m-type');
  await page.fill('#typed','today machboos again');
  await expect(page.locator('#lastnote')).toBeVisible();
});
test('F1 offline/no key: card without sentence',async({page})=>{
  await clean(page);await page.goto('/');const id=await seed(page);
  await page.evaluate(()=>localStorage.removeItem('groq_api_key'));
  await page.goto('/#/dish/'+id);
  await expect(page.locator('#why')).toBeVisible();await expect(page.locator('#why-ai')).toHaveText('');
});
test('F3: use up from pantry, only ticked removed',async({page})=>{
  const log=[];await clean(page);await ai(page,log);await page.goto('/');
  await page.evaluate(()=>{localStorage.setItem('cj_pantry',JSON.stringify(['rice','saffron','milk']));
    return import('/js/db.js').then(db=>db.saveDraft({name:'Pilaf',ingredients:[{name:'rice',amount:'2',unit:'cups'},{name:'saffron',amount:'1',unit:'pinch'}],steps:['x'],transcript:'t',parts:[],long:false,pendingIds:[],marks:[{t:65,text:'add <b>salt</b>'}]}))});
  await page.goto('about:blank');await page.goto('/#/review');
  await expect(page.locator('#marks')).toContainText('1:05');
  await expect(page.locator('#marks')).toContainText('add <b>salt</b>');
  await page.click('#save');
  await expect(page.locator('#useup li')).toHaveCount(2);
  await page.locator('#useup input').first().check();
  await page.click('#useup-go');
  await expect(page).toHaveURL(/#\/version\//);
  await expect(page.locator('#marks')).toContainText('1:05');
  expect(await page.evaluate(()=>JSON.parse(localStorage.cj_pantry))).toEqual(['saffron','milk']);
});
test('F3: skip removes nothing',async({page})=>{
  await clean(page);await page.goto('/');
  await page.evaluate(()=>{localStorage.setItem('cj_pantry',JSON.stringify(['rice']));
    return import('/js/db.js').then(db=>db.saveDraft({name:'P',ingredients:[{name:'rice',amount:'1',unit:'cup'}],steps:[],transcript:'t',parts:[],pendingIds:[]}))});
  await page.goto('about:blank');await page.goto('/#/review');await page.click('#save');
  await page.click('#useup-skip');await expect(page).toHaveURL(/#\/version\//);
  expect(await page.evaluate(()=>JSON.parse(localStorage.cj_pantry))).toEqual(['rice']);
});
test('F5: Mark while recording saves timestamped notes and shows on review',async({page})=>{
  const log=[];await clean(page);
  await page.route('**/audio/transcriptions',r=>r.fulfill({json:{text:'machboos with rice'}}));
  await ai(page,log);await page.goto('/');
  await page.click('#rec');await expect(page.locator('#rec')).toHaveText('Stop');
  await page.waitForTimeout(1200);
  await page.click('.mark');await page.fill('.marktext','more <b>heat</b>');await page.press('.marktext','Enter');
  await page.click('.mark');
  await expect(page.locator('.mark')).toContainText('(2)');
  await page.click('#rec');
  await expect(page.locator('#name')).toHaveValue('Machboos');
  await expect(page.locator('#marks li')).toHaveCount(2);
  await expect(page.locator('#marks li').first()).toContainText('more <b>heat</b>');
  await expect(page.locator('#marks li').first()).toContainText(/0:0\d/);
});
