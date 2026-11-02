// Generates screenshots/*.png at 390x844 (mobile project only). Not an assertion-heavy test.
const {test,expect}=require('@playwright/test');
const OUT=process.env.SHOTS_DIR||'test-results/screenshots'; // set SHOTS_DIR=screenshots to refresh the committed images on purpose
require('fs').mkdirSync(OUT,{recursive:true});


test('capture home, recording, dish progress',async({page},info)=>{
  test.skip(info.project.name!=='mobile','mobile only');
  await page.addInitScript(()=>{if(!sessionStorage.seeded){localStorage.clear();sessionStorage.seeded=1;
    localStorage.setItem('groq_api_key','gsk_test');
    const d=new Date(),f=x=>`${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`;
    localStorage.setItem('cj_game',JSON.stringify({xp:265,streak:3,best:3,lastDay:f(d),badges:['first-dish','tinkerer','taster','five-star','streak3'],counts:{dish:4,rate:3,five:1,append:0,marathon:0,maxVersions:4}}));}});
  await page.goto('/');
  await page.evaluate(async()=>{
    const db=await import('/js/db.js'),b=()=>new Blob(['x'],{type:'audio/webm'});
    const mk=async(name,r)=>{const v=await db.saveVersion({name,ingredients:[{name:'rice',amount:'2',unit:'cups'}],steps:['Boil'],transcript:'t',parts:[b()]});
      if(r)await db.saveAfter(v.id,{rating:r,notes:'n',transcript:'t',audio:b(),parts:[b()]})};
    for(const r of [2,3,3,5])await mk('Machboos',r);
    await mk('Harees',4);await mk('Shuwa',0);
  });
  await page.reload();
  await expect(page.locator('.card')).toHaveCount(3);
  await page.screenshot({path:OUT+'/home.png',fullPage:true});

  await page.click('#rec');
  await page.waitForTimeout(1600);
  await page.click('.pause');
  await page.waitForTimeout(300);
  await page.screenshot({path:OUT+'/recording.png'});
  page.on('dialog',d=>d.accept()); // leaving mid-recording now asks first

  await page.goto('/#/');
  await page.locator('a.card',{hasText:'Machboos'}).click();
  await expect(page.locator('svg.chart')).toBeVisible();
  await page.screenshot({path:OUT+'/dish.png',fullPage:true});
});
