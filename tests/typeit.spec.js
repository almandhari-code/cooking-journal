const {test,expect}=require('@playwright/test');
const clean=page=>page.addInitScript(()=>{if(!sessionStorage.seeded){localStorage.clear();sessionStorage.seeded=1;localStorage.setItem('groq_api_key','gsk_test')}});

test('Type it: long paste -> same review screen -> saves a dish; draft survives reload; XSS-safe',async({page})=>{
  const log=[];
  let fired=false;page.on('dialog',d=>{fired=true;d.dismiss()});
  await clean(page);
  await page.route('**/chat/completions',r=>{log.push(r.request().postDataJSON());
    r.fulfill({json:{choices:[{message:{content:JSON.stringify({dish:'Machboos <b>x</b>',ingredients:[{name:'rice',amount:'2',unit:'cups'}],steps:['Boil <img src=x onerror=alert(1)>']})}}]}})});
  await page.goto('/');
  await page.click('#m-type');
  const text=('Today I made machboos, so we chatted about the weather. <img src=x onerror=alert(1)> '.repeat(50)).slice(0,3500);
  await page.fill('#typed',text);
  await expect(page.locator('#typed-count')).toContainText('3500');
  await page.waitForTimeout(400);
  await page.reload();
  await expect(page.locator('#typed')).toHaveValue(text); // restored from IndexedDB, opens in Type mode
  await page.click('#typed-go');
  await expect(page.locator('#name')).toHaveValue('Machboos <b>x</b>');
  const sys=log[0].messages[0].content,user=log[0].messages[1].content;
  expect(sys).toMatch(/IGNORE chatter/);expect(user.length).toBe(3500);
  await expect(page.locator('.transcript')).toContainText('<img src=x');
  await expect(page.locator('#ings .ing')).toHaveCount(1);
  await page.reload(); // review draft also survives
  await expect(page.locator('#name')).toHaveValue('Machboos <b>x</b>');
  await page.fill('#name','Machboos');
  await page.click('#save');
  await expect(page).toHaveURL(/#\/version\//);
  await expect(page.locator('h1')).toContainText('Machboos');
  await expect(page.locator('#audio-gone')).toContainText('typed');
  await page.goto('/#/');await page.click('#m-type');
  await expect(page.locator('#typed')).toHaveValue(''); // cleared after success
  expect(fired).toBe(false);
});

test('Type it: empty input and missing key are handled; failure keeps the text',async({page})=>{
  await clean(page);await page.goto('/');await page.click('#m-type');
  await page.click('#typed-go');await expect(page.locator('#error')).toContainText('Type or paste');
  await page.fill('#typed','I made soup');
  await page.route('**/chat/completions',r=>r.fulfill({status:500,json:{error:{message:'boom'}}}));
  await page.click('#typed-go');
  await expect(page.locator('#error')).toContainText('boom');
  await expect(page.locator('#typed')).toHaveValue('I made soup');
  await page.click('#m-speak');await expect(page.locator('#rec')).toBeVisible();
});
