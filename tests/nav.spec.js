const {test,expect}=require('@playwright/test');
const b=()=>new Blob(['x'],{type:'audio/webm'});
async function seed(page){
  await page.addInitScript(()=>{if(!sessionStorage.s){localStorage.clear();sessionStorage.s=1;(localStorage.setItem('cj_onboarded','1'),localStorage.setItem('groq_api_key','gsk_test'))}});
  await page.goto('/');
  await page.evaluate(async()=>{
    const db=await import('/js/db.js'),bl=()=>new Blob(['x'],{type:'audio/webm'});
    const mk=async(name,r)=>{const v=await db.saveVersion({name,ingredients:[],steps:['x'],transcript:'t',parts:[bl()]});
      if(r)await db.saveAfter(v.id,{rating:r,notes:'n',transcript:'t',audio:bl(),parts:[bl()]})};
    await mk('Machboos',4);await mk('Shuwa',0);await mk('Harees',5);
  });
}
test('tab bar: five tabs, Record in the middle, each tab opens its page',async({page})=>{
  await seed(page);await page.reload();
  const tabs=page.locator('#tabs > *');
  await expect(tabs).toHaveText([/Home/,/Dishes/,/Record/,/Pantry/,/Me/]);
  await expect(page.locator('#tab-home')).toHaveAttribute('aria-current','page');
  await page.click('#tab-dishes');await expect(page.locator('h1')).toHaveText('My dishes');
  await expect(page.locator('#tab-dishes')).toHaveAttribute('aria-current','page');
  await page.click('#tab-pantry');await expect(page.locator('h1')).toContainText('My pantry');
  await page.click('#tab-me');await expect(page.locator('h1')).toHaveText('Me');
  await expect(page.locator('#level')).toBeVisible();await expect(page.locator('.badge').first()).toBeVisible();await expect(page.locator('#key')).toBeVisible();
  await page.click('#tab-rec');await expect(page.locator('#rec')).toBeVisible();    // from another tab: goes Home
});
test('Home: level strip, big Record, at most 3 recent dishes, no pantry/install cards',async({page})=>{
  await seed(page);await page.reload();
  await expect(page.locator('#level')).toBeVisible();await expect(page.locator('#rec')).toBeVisible();
  await expect(page.locator('.recent .card')).toHaveCount(3);
  await expect(page.locator('.pantry-link,.tile')).toHaveCount(0);
  await expect(page.locator('.badge')).toHaveCount(0);
});
test('install is a small header icon, shown only when installable',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('cj_onboarded','1'));
  await page.goto('/');await expect(page.locator('#install')).toBeHidden();
  await page.evaluate(()=>{const e=new Event('beforeinstallprompt',{cancelable:true});window.__p=0;e.prompt=async()=>{window.__p++};window.dispatchEvent(e)});
  const i=page.locator('.top #install');await expect(i).toBeVisible();
  const box=await i.boundingBox();expect(box.width).toBeLessThan(50);
  await i.click();expect(await page.evaluate(()=>window.__p)).toBe(1);
});
test('dish status: rated = finished, unrated = planning; filter chips',async({page})=>{
  await seed(page);await page.goto('/#/dishes');
  const cards=page.locator('#dlist .card');
  await expect(cards).toHaveCount(3);
  await expect(page.locator('.card',{hasText:'Shuwa'}).locator('.status')).toHaveText(/Planning/);
  await expect(page.locator('.card',{hasText:'Machboos'}).locator('.status')).toHaveText(/Finished/);
  await page.click('.fchip[data-f=planning]');await expect(cards).toHaveCount(1);await expect(cards).toContainText('Shuwa');
  await page.click('.fchip[data-f=finished]');await expect(cards).toHaveCount(2);
  await page.click('.fchip[data-f=all]');await expect(cards).toHaveCount(3);
});
