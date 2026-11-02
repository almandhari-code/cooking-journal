const {test,expect}=require('@playwright/test');

/** Mock Groq; records every request. Each whisper call returns "chunk N". */
async function mock(page,log){
  await page.route('**/audio/transcriptions',r=>{
    const body=r.request().postData()||'';
    log.whisper.push(body);
    r.fulfill({json:{text:`chunk${log.whisper.length} blah`}});
  });
  await page.route('**/chat/completions',r=>{
    const b=r.request().postDataJSON();
    log.chat.push(b);
    const user=b.messages[1].content;
    const out=/rating/.test(b.messages[0].content)?{rating:5,notes:'Perfect.'}
      :/chunk3|chunk2/.test(user)&&log.append?{dish:'Machboos',ingredients:[{name:'saffron',amount:'1',unit:'pinch'},{name:'rice',amount:'2',unit:'cups'}],steps:['Add saffron']}
      :{dish:'Machboos',ingredients:[{name:'rice',amount:'2',unit:'cups'}],steps:['Boil rice']};
    r.fulfill({json:{choices:[{message:{content:JSON.stringify(out)}}]}});
  });
}
const seedKey=page=>page.addInitScript(()=>{if(!localStorage.groq_api_key)localStorage.setItem('groq_api_key','gsk_test')});
const clean=page=>page.addInitScript(()=>{if(!sessionStorage.seeded){localStorage.clear();sessionStorage.seeded=1;localStorage.setItem('groq_api_key','gsk_test')}});

test('pause/resume keeps one session; Whisper gets Omani vocab; extraction prompt ignores chatter',async({page})=>{
  const log={whisper:[],chat:[]};
  await clean(page);await mock(page,log);await page.goto('/');
  await page.click('#rec');
  await expect(page.locator('#rec')).toHaveText('Stop');
  await expect(page.locator('.pause')).toBeVisible();
  await page.waitForTimeout(700);
  await page.click('.pause');
  await expect(page.locator('.pause')).toHaveText(/Resume/);
  const t1=await page.locator('.timer').textContent();
  await page.waitForTimeout(1200);               // paused: timer must not advance
  expect(await page.locator('.timer').textContent()).toBe(t1);
  await page.click('.pause');
  await expect(page.locator('.pause')).toHaveText(/Pause/);
  await page.waitForTimeout(700);
  await page.click('#rec');
  await expect(page.locator('#name')).toHaveValue('Machboos');
  expect(log.whisper.length).toBe(1);            // one session = one part
  for(const w of ['machboos','bzar','shuwa','harees','mashuai','laban','qahwa','halwa','kahwa','maqboos','saloona','mashkak','khubz','dates','cardamom','saffron','loomi'])
    expect(log.whisper[0]).toContain(w);
  expect(log.whisper[0]).toContain('name="prompt"');
  const sys=log.chat[0].messages[0].content;
  expect(sys).toMatch(/IGNORE chatter/);
  expect(sys).toMatch(/makbous.*machboos/);
  expect(sys).toMatch(/bazaar.*bzar/);
  expect((await page.evaluate(()=>window.__cjSounds)).join()).toContain('pause');
});

test('long session is chunked, each chunk transcribed in order and merged',async({page})=>{
  const log={whisper:[],chat:[]};
  await clean(page);await mock(page,log);
  await page.addInitScript(()=>{window.CJ_CHUNK_MS=1000});
  await page.goto('/');
  await page.click('#rec');
  await page.waitForTimeout(3400);
  await page.click('#rec');
  await expect(page.locator('#name')).toBeVisible();
  expect(log.whisper.length).toBeGreaterThanOrEqual(3);
  // later chunks carry the previous text as prompt context
  expect(log.whisper[1]).toContain('chunk1 blah');
  const t=await page.locator('.transcript').textContent();
  const idx=[...t.matchAll(/chunk(\d+)/g)].map(m=>+m[1]);
  expect(idx).toEqual([...idx].sort((a,b)=>a-b));
  expect(idx.length).toBe(log.whisper.length);
  // chat was called once with the merged transcript
  expect(log.chat.length).toBe(1);
  await page.click('#save');
  await expect(page.locator('audio')).toHaveCount(log.whisper.length);
  await expect(page.locator('.toast')).toContainText('Marathon');
});

test('"Add to this dish" on review and on a saved version appends',async({page})=>{
  const log={whisper:[],chat:[],append:true};
  await clean(page);await mock(page,log);await page.goto('/');
  await page.click('#rec');await page.waitForTimeout(800);await page.click('#rec');
  await expect(page.locator('#ings .ing')).toHaveCount(1);
  await page.fill('#name','Machboos');
  await page.click('#add-more');
  await expect(page.locator('#add-more')).toHaveText('Stop');
  await expect(page.locator('#add-more')).toBeEnabled();
  await page.waitForTimeout(800);await page.click('#add-more');
  await expect(page.locator('#ings .ing')).toHaveCount(2);        // saffron merged, rice not duplicated
  await expect(page.locator('.step textarea')).toHaveCount(2);
  await expect(page.locator('#name')).toHaveValue('Machboos');    // edits preserved
  await page.click('#save');
  await expect(page.locator('audio')).toHaveCount(2);
  // append to the saved version
  log.append=false;
  await page.click('#add-more');await page.waitForTimeout(800);await page.click('#add-more');
  await expect(page.locator('audio')).toHaveCount(3);
  await expect(page.locator('details')).toBeVisible();
  await expect(page.locator('.toast')).toContainText('+20 XP');
});

test('XP, badges and per-dish progress chart',async({page})=>{
  const log={whisper:[],chat:[]};
  await clean(page);await mock(page,log);await page.goto('/');
  await expect(page.locator('#level')).toHaveText('Level 1');
  await page.click('#rec');await page.waitForTimeout(800);await page.click('#rec');
  await page.click('#save');
  await expect(page.locator('.toast')).toContainText('First Dish');
  let g=await page.evaluate(()=>JSON.parse(localStorage.cj_game));
  expect(g.xp).toBe(5+50+25);expect(g.streak).toBe(1);expect(g.badges).toContain('first-dish');
  // rate v1 (5 stars) -> 30+10 XP, Taste Tester + Five Stars badges
  await page.click('#rec');await page.waitForTimeout(800);await page.click('#rec');
  await page.click('#save-after');
  await expect(page.locator('.toast')).toContainText('+40 XP');
  g=await page.evaluate(()=>JSON.parse(localStorage.cj_game));
  expect(g.xp).toBe(120);expect(g.badges).toEqual(expect.arrayContaining(['taster','five-star']));
  await expect(page.locator('.toast')).toContainText('Level 2');
  // v2 of the same dish, unrated -> chart shows rated v1 and an empty v2 slot
  await page.goto('/#/');
  await expect(page.locator('#level')).toHaveText('Level 2');
  await page.click('#rec');await page.waitForTimeout(800);await page.click('#rec');
  await page.click('#save');
  await page.click('#app a.link');
  await expect(page.locator('svg.chart')).toBeVisible();
  await expect(page.locator('svg.chart .pt')).toHaveCount(1);
  await expect(page.locator('svg.chart .empty')).toHaveCount(1);
  await expect(page.locator('svg.chart')).toHaveAttribute('aria-label',/v1: 5 stars, v2: not rated/);
  await expect(page.locator('#trend')).toContainText('One rating');
});

test('weekly streak: same week keeps it, next week adds, a skipped week lapses',async({page})=>{
  await clean(page);await page.goto('/');
  const r=await page.evaluate(async()=>{
    const game=await import('/js/game.js');
    const d=n=>new Date(2026,0,n,12); // Jan 5 2026 is a Monday
    const a=game.award('append',{},d(5)),a2=game.award('append',{},d(8)),same=game.award('append',{},d(11)), // Mon, Thu, Sun: one week
      b=game.award('append',{},d(12)),c=game.award('append',{},d(19)); // next two weeks
    const stillOk=game.currentStreak(game.load(),d(31)),lapsed=game.currentStreak(game.load(),new Date(2026,1,9,12)); // next week still ok; skipping a whole week lapses
    const e=game.award('append',{},new Date(2026,1,9,12));
    return {a:a.streak,a2:a2.streak,a2bonus:a2.streakBonus,same:same.streak,b:b.streak,c:c.streak,stillOk,lapsed,e:e.streak,badges:game.load().badges};
  });
  expect(r).toMatchObject({a:1,a2:1,a2bonus:0,same:1,b:2,c:3,stillOk:3,lapsed:0,e:1});
  expect(r.badges).toContain('streak3');
});

test('mute toggle silences sounds and is saved in settings',async({page})=>{
  await clean(page);await page.goto('/');
  await page.click('#mute');
  await expect(page.locator('#mute')).toHaveAttribute('aria-pressed','true');
  expect(await page.evaluate(()=>JSON.parse(localStorage.cj_settings).mute)).toBe(true);
  await page.evaluate(()=>{window.__cjSounds=[]});
  await page.click('#rec');await page.waitForTimeout(300);await page.click('#rec');
  expect(await page.evaluate(()=>window.__cjSounds)).toEqual([]);
  await page.reload();
  await expect(page.locator('#mute')).toHaveAttribute('aria-pressed','true');
  await page.goto('/#/settings');
  await expect(page.locator('#mute-setting')).toBeChecked();
  await page.uncheck('#mute-setting');
  await expect(page.locator('#mute')).toHaveAttribute('aria-pressed','false');
  await page.click('#tab-me');
  await page.evaluate(()=>import('/js/sound.js').then(m=>m.play('success')));
  expect(await page.evaluate(()=>window.__cjSounds)).toEqual(['success']);
});

test('oversized chunk is rejected before upload',async({page})=>{
  await clean(page);await page.goto('/');
  const msg=await page.evaluate(async()=>{
    const g=await import('/js/groq.js');
    try{await g.transcribe({size:26*1024*1024,type:'audio/webm'})}catch(e){return e.message}
  });
  expect(msg).toContain('25 MB');
});
