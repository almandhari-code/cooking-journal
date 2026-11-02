const {test,expect}=require('@playwright/test');

const seed=page=>page.addInitScript(()=>{if(!sessionStorage.seeded){localStorage.clear();sessionStorage.seeded=1;localStorage.setItem('groq_api_key','gsk_test')}});
const chatOK=page=>page.route('**/chat/completions',r=>{
  const b=r.request().postDataJSON();
  const out=/rating/.test(b.messages[0].content)?{rating:5,notes:'ok'}:{dish:'Machboos',ingredients:[{name:'rice',amount:'2',unit:'cups'}],steps:['Boil rice']};
  r.fulfill({json:{choices:[{message:{content:JSON.stringify(out)}}]}});
});
const rec=async(page,ms=800)=>{await page.click('#rec');await expect(page.locator('#rec')).toHaveText('Stop');await page.waitForTimeout(ms);await page.click('#rec')};

test('1: 429 keeps the audio; survives reload; Retry finishes the recipe',async({page})=>{
  await seed(page);
  await page.addInitScript(()=>{window.CJ_MAX_TRIES=1;window.CJ_QUEUE_MS=3600000});
  await page.route('**/audio/transcriptions',r=>r.fulfill({status:429,headers:{'retry-after':'1'},json:{error:{message:'slow down'}}}));
  await chatOK(page);
  await page.goto('/');
  await rec(page);
  await expect(page.locator('#error')).toContainText('rate limit');
  await expect(page.locator('#pending .pend')).toHaveCount(1);
  await expect(page.locator('#pending .retry')).toHaveText('Retry');
  await page.reload();
  await expect(page.locator('#pending .pend')).toHaveCount(1);        // audio is still here
  expect(await page.evaluate(async()=>{const db=await import('/js/db.js');const [p]=await db.listPending();return p.parts[0].size>0&&p.parts.length})).toBe(1);
  await page.unroute('**/audio/transcriptions');
  await page.route('**/audio/transcriptions',r=>r.fulfill({json:{text:'rice please'}}));
  await page.click('#pending .retry');
  await expect(page.locator('#name')).toHaveValue('Machboos');
  await page.click('#save');
  await expect(page.locator('audio')).toHaveCount(1);
  await page.goto('/#/');
  await expect(page.locator('#pending .pend')).toHaveCount(0);        // cleaned up after Save
});
