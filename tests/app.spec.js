const {test,expect}=require('@playwright/test');
let proj='';
const shot=(page,name)=>page.screenshot({path:`tests/screenshots/${proj}-${name}.png`,fullPage:true});

async function mockGroq(page,calls){
  await page.route('https://api.groq.com/openai/v1/audio/transcriptions',r=>{
    calls.whisper++;
    r.fulfill({json:{text:calls.whisper>=3?'It was delicious, maybe four stars, needs more salt.':'Today I made tomato pasta with two cups of pasta and three tomatoes. Boil the pasta then add sauce.'}});
  });
  await page.route('https://api.groq.com/openai/v1/chat/completions',r=>{
    const b=r.request().postDataJSON();
    calls.models.push(b.model);
    expect(b.response_format).toEqual({type:'json_object'});
    expect(r.request().headers().authorization).toBe('Bearer gsk_test');
    const out=/rating/.test(b.messages[0].content)
      ?{rating:4,notes:'Needs more salt.'}
      :{dish:'Tomato Pasta',ingredients:[{name:'pasta',amount:'2',unit:'cups'},{name:'tomatoes',amount:'3',unit:''}],steps:['Boil the pasta','Add sauce']};
    r.fulfill({json:{choices:[{message:{content:JSON.stringify(out)}}]}});
  });
}
async function record(page){
  await page.locator('#rec').click();
  await expect(page.locator('#rec')).toHaveText('Stop');
  await page.waitForTimeout(1200);
  await page.locator('#rec').click();
}

test('full flow',async({page},info)=>{
  proj=info.project.name;
  const calls={whisper:0,models:[]};
  await mockGroq(page,calls);
  await page.goto('/');
  // missing key prompts settings
  await page.locator('#rec').click();
  await expect(page.locator('#error')).toContainText('Groq API key');
  await shot(page,'home-nokey');
  await page.locator('#error a').click();
  await page.fill('#key','gsk_test');
  await page.click('#save-key');
  await expect(page.locator('#saved')).toHaveText('Saved.');
  await shot(page,'settings');
  await page.reload();
  await expect(page.locator('#key')).toHaveValue('gsk_test');

  // v1
  await page.goto('/#/');
  await record(page);
  await expect(page.locator('#name')).toHaveValue('Tomato Pasta');
  await expect(page.locator('#ings .ing')).toHaveCount(2);
  await page.click('#add-ing');
  await page.locator('#ings .ing').last().locator('[data-f=name]').fill('salt');
  await shot(page,'review');
  await page.click('#save');
  await expect(page.locator('h1')).toContainText('Tomato Pasta');
  await expect(page.locator('h1')).toContainText('v1');
  await expect(page.locator('audio')).toHaveCount(1);
  await shot(page,'version');

  // v2, same name different case
  await page.goto('/#/');
  await record(page);
  await page.fill('#name','tomato pasta');
  await page.click('#save');
  await expect(page.locator('h1')).toContainText('v2');
  await page.goto('/#/');
  await expect(page.locator('.card')).toHaveCount(1);
  await expect(page.locator('.card')).toContainText('2 versions');

  // after eating
  await page.locator('.card').click();
  await page.locator('a.card',{hasText:'Version 2'}).click();
  await record(page);
  await expect(page.locator('#notes')).toHaveValue('Needs more salt.');
  await expect(page.locator('#rating')).toHaveValue('4');
  await shot(page,'after-review');
  await page.click('#save-after');
  await expect(page.locator('#after .stars')).toContainText('★★★★☆');
  await shot(page,'after-saved');
  expect(calls.models.every(m=>m==='openai/gpt-oss-120b')).toBe(true);
});

test('errors: mic denied and API failure',async({browser})=>{
  const ctx=await browser.newContext({permissions:[]});
  const page=await ctx.newPage();
  await page.addInitScript(()=>{localStorage.setItem('groq_api_key','gsk_test');
    navigator.mediaDevices.getUserMedia=()=>Promise.reject(Object.assign(new Error('x'),{name:'NotAllowedError'}))});
  await page.goto('/');
  await page.locator('#rec').click();
  await expect(page.locator('#error')).toContainText('Microphone access was denied');
  await ctx.close();
});

test('errors: network failure shown',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('groq_api_key','gsk_test'));
  await page.route('https://api.groq.com/**',r=>r.abort());
  await page.goto('/');
  await record(page);
  await expect(page.locator('#error')).toContainText('Network error');
  await expect(page.locator('#rec')).toBeVisible();
});

test('fallback model used when primary fails',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('groq_api_key','gsk_test'));
  const models=[];
  await page.route('**/audio/transcriptions',r=>r.fulfill({json:{text:'pasta'}}));
  await page.route('**/chat/completions',r=>{
    const m=r.request().postDataJSON().model;models.push(m);
    if(m.startsWith('openai'))return r.fulfill({status:500,json:{error:{message:'boom'}}});
    r.fulfill({json:{choices:[{message:{content:'{"dish":"Pasta","ingredients":[],"steps":[]}'}}]}});
  });
  await page.goto('/');
  await record(page);
  await expect(page.locator('#name')).toHaveValue('Pasta');
  expect(models).toEqual(['openai/gpt-oss-120b','qwen/qwen3.8-27b']);
});
