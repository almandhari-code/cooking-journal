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

const liveOf=page=>page.evaluate(async()=>{const db=await import('/js/db.js');const [p]=await db.listPending();return p?{parts:p.parts.length,live:p.live?p.live.size:0,status:p.status}:null});

test('2: leaving mid-recording asks first; hidden/unload flush partial audio to IndexedDB',async({page})=>{
  await seed(page);
  await page.addInitScript(()=>{window.CJ_CHUNK_MS=3600000});
  await page.route('**/audio/transcriptions',r=>r.fulfill({json:{text:'x'}}));
  await chatOK(page);
  await page.goto('/');
  await page.click('#rec');
  await expect(page.locator('#rec')).toHaveText('Stop');
  await page.waitForTimeout(600);
  // hidden -> partial audio is stored although nothing was stopped
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'hidden'});document.dispatchEvent(new Event('visibilitychange'))});
  await expect.poll(async()=>(await liveOf(page))?.live).toBeGreaterThan(0);
  // beforeunload does the same: after more audio, the stored partial grows
  const before=(await liveOf(page)).live;
  await page.waitForTimeout(700);
  await page.evaluate(()=>window.dispatchEvent(new Event('beforeunload')));
  await expect.poll(async()=>(await liveOf(page)).live).toBeGreaterThan(before);
  // navigating away: cancel keeps recording
  const dialogs=[];
  page.on('dialog',d=>{dialogs.push(d.message());dialogs.length===1?d.dismiss():d.accept()});
  await page.click('#tab-me');
  await expect.poll(()=>dialogs.length).toBe(1);
  expect(dialogs[0]).toContain('recording');
  await expect(page.locator('#rec')).toHaveText('Stop');
  expect(await page.evaluate(()=>location.hash)).not.toContain('settings');
  // confirm: leaves, and the audio is kept as a pending session
  await page.click('#tab-me');
  await expect(page.locator('h1')).toHaveText('Me');
  await expect(page.locator('#pending .pend')).toHaveCount(1);
  const s=await liveOf(page);
  expect(s.parts).toBeGreaterThanOrEqual(1);expect(s.live).toBe(0);
});

test('3: wake lock requested on start, re-requested when visible again, released on stop',async({page})=>{
  await seed(page);
  await page.addInitScript(()=>{
    window.__wl={req:0,rel:0,sentinels:[]};
    Object.defineProperty(navigator,'wakeLock',{configurable:true,value:{request:async()=>{
      const s={released:false,release:async()=>{if(!s.released){s.released=true;window.__wl.rel++}}};
      window.__wl.req++;window.__wl.sentinels.push(s);return s}}});
  });
  await page.route('**/audio/transcriptions',r=>r.fulfill({json:{text:'x'}}));
  await chatOK(page);
  await page.goto('/');
  expect(await page.evaluate(()=>window.__wl.req)).toBe(0);
  await page.click('#rec');
  await expect(page.locator('#rec')).toHaveText('Stop');
  await expect.poll(()=>page.evaluate(()=>window.__wl.req)).toBe(1);
  // page hidden: the browser releases the lock by itself; visible again -> we ask again
  await page.evaluate(()=>{window.__wl.sentinels[0].released=true;
    Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'hidden'});document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'visible'});document.dispatchEvent(new Event('visibilitychange'))});
  await expect.poll(()=>page.evaluate(()=>window.__wl.req)).toBe(2);
  await page.click('#rec');
  await expect(page.locator('#name')).toBeVisible();
  expect(await page.evaluate(()=>window.__wl.sentinels[1].released)).toBe(true);
  // after stop, visibility changes no longer grab a lock
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(200);
  expect(await page.evaluate(()=>window.__wl.req)).toBe(2);
});

/** Everything the user owns, comparable: IndexedDB rows with audio as base64, plus cj_* localStorage. */
const snapshot=page=>page.evaluate(async()=>{
  const db=await import('/js/db.js');
  const b64=b=>new Promise(r=>{const f=new FileReader();f.onload=()=>r(f.result);f.readAsDataURL(b)});
  const enc=async v=>v instanceof Blob?{blob:await b64(v)}:Array.isArray(v)?Promise.all(v.map(enc)):v&&typeof v==='object'?Object.fromEntries(await Promise.all(Object.entries(v).map(async([k,x])=>[k,await enc(x)]))):v;
  const ls={};for(const k of Object.keys(localStorage))if(k.startsWith('cj_'))ls[k]=localStorage[k];
  return {db:await enc(await db.dumpAll()),ls};
});

test('4: export zip, clear everything, import, identical; persist() asked; install prompt',async({page})=>{
  await seed(page);
  await page.addInitScript(()=>{window.__persist=0;
    Object.defineProperty(navigator,'storage',{configurable:true,value:{persist:async()=>{window.__persist++;return true},persisted:async()=>true,estimate:async()=>({})}})});
  await page.route('**/audio/transcriptions',r=>r.fulfill({json:{text:'rice please'}}));
  await chatOK(page);
  await page.goto('/');
  expect(await page.evaluate(()=>window.__persist)).toBeGreaterThan(0);
  // a saved dish, a rating, a pending session, pantry, game state
  await rec(page);await page.click('#save');
  await page.click('#rec');await page.waitForTimeout(600);await page.click('#rec');await page.click('#save-after');
  await page.evaluate(async()=>{const db=await import('/js/db.js');const p=await db.createPending({kind:'pantry',status:'error',error:'e'});
    await db.patchPending(p.id,{parts:[new Blob(['pending-audio'],{type:'audio/webm'})]});
    const pan=await import('/js/pantry.js');pan.add(['rice','onion'])});
  const before=await snapshot(page);
  expect(before.db.versions[0].parts[0].blob).toMatch(/^data:audio/);
  expect(Object.keys(before.ls)).toEqual(expect.arrayContaining(['cj_game','cj_pantry']));

  await page.goto('/#/settings');
  const [dl]=await Promise.all([page.waitForEvent('download'),page.click('#export')]);
  expect(dl.suggestedFilename()).toMatch(/^cooking-journal-.*\.zip$/);
  const file=await dl.path();

  // wipe everything
  await page.evaluate(async()=>{const db=await import('/js/db.js');await db.restoreAll({});Object.keys(localStorage).filter(k=>k.startsWith('cj_')).forEach(k=>localStorage.removeItem(k))});
  const wiped=await snapshot(page);
  expect(wiped.db.versions).toEqual([]);expect(wiped.ls).toEqual({});

  page.on('dialog',d=>d.accept());
  await page.setInputFiles('#import',file);
  await expect.poll(()=>page.evaluate(()=>location.hash)).toBe('#/');
  await expect(page.locator('.card')).toHaveCount(1);
  const after=await snapshot(page);
  expect(after).toEqual(before);
  expect(await page.evaluate(()=>localStorage.groq_api_key)).toBe('gsk_test'); // untouched, never exported
});

test('4b: bad file is rejected without touching data',async({page})=>{
  await seed(page);await page.goto('/#/settings');
  page.on('dialog',d=>d.accept());
  await page.setInputFiles('#import',{name:'x.zip',mimeType:'application/zip',buffer:Buffer.from('not a zip at all, definitely')});
  await expect(page.locator('#data-status')).toContainText('Import failed');
});

test('4c: install tile appears on beforeinstallprompt and calls prompt()',async({page})=>{
  await seed(page);await page.goto('/');
  await expect(page.locator('#install')).toBeHidden();
  await page.evaluate(()=>{const e=new Event('beforeinstallprompt',{cancelable:true});window.__prompted=0;e.prompt=async()=>{window.__prompted++};window.dispatchEvent(e)});
  await expect(page.locator('#install')).toBeVisible();
  await page.click('#install');
  expect(await page.evaluate(()=>window.__prompted)).toBe(1);
});

/** A MediaRecorder that never touches real audio: timeslice chunks are text, so parts can be inspected.
 *  cfg.mime: the only supported type. cfg.oneAtATime: starting a 2nd recorder on the stream throws (like iOS). */
const fakeMR=cfg=>{
  let active=0,ids=0;
  class MR{
    static isTypeSupported(t){return t===cfg.mime}
    constructor(stream,o){this.state='inactive';this.mimeType=o.mimeType||cfg.mime;this.id=++ids;this.n=0;this.buf=[]}
    _chunk(){return `${this.n++?`${this.id}.${this.n};`:`INIT${this.id};`}`}
    _emit(txt){this.ondataavailable?.({data:new Blob([txt],{type:this.mimeType})})}
    start(ts){
      if(cfg.oneAtATime&&active>=1)throw new DOMException('only one recorder per stream','InvalidStateError');
      active++;this.state='recording';
      if(ts)this.iv=setInterval(()=>this._emit(this._chunk()),ts);
    }
    requestData(){this._emit(this._chunk())}
    pause(){this.state='paused'}resume(){this.state='recording'}
    stop(){clearInterval(this.iv);this._emit(this._chunk());this.state='inactive';active--;setTimeout(()=>this.onstop?.(),0)}
  }
  window.MediaRecorder=MR;
};
async function threeMinutes(page,cfg){
  await seed(page);
  await page.addInitScript(fakeMR,cfg);
  await page.addInitScript(()=>{window.CJ_CHUNK_MS=60000});
  await page.clock.install();
  await page.goto('/');
  await page.evaluate(async()=>{const {Recorder}=await import('/js/recorder.js');window.__r=new Recorder();await window.__r.start()});
  await page.clock.runFor(180000);
  await page.evaluate(()=>{window.__stop=window.__r.stop().then(p=>(window.__done=true,p))});
  for(let i=0;i<40&&!(await page.evaluate(()=>window.__done));i++)await page.clock.runFor(50); // wait for the recorder to finish, not a fixed time
  return page.evaluate(async()=>{const parts=await window.__stop;return {single:window.__r.single,parts:await Promise.all(parts.map(b=>b.text()))}});
}
function expectPlayableParts(r){
  expect(r.parts).toHaveLength(3);
  const seen=[];
  for(const t of r.parts){
    expect(t).toMatch(/^INIT\d+;/);                       // every part starts with an init chunk: decodes on its own
    expect(t.match(/INIT/g)).toHaveLength(1);
    for(const id of t.match(/\d+\.\d+/g)||[])seen.push(id);
  }
  expect(new Set(seen).size).toBe(seen.length);           // no audio duplicated between parts
  expect(seen.length).toBeGreaterThan(20);                // and nothing dropped: ~36 timeslices of 5 s
}

test('5: iOS-style (mp4, one recorder per stream): 3 min at 60000 ms -> 3 playable parts via single recorder',async({page})=>{
  const r=await threeMinutes(page,{mime:'audio/mp4',oneAtATime:true});
  expect(r.single).toBe(true);expectPlayableParts(r);
});
test('5b: webm where the 2nd recorder fails at the first cut falls back to single recorder, still 3 parts',async({page})=>{
  const r=await threeMinutes(page,{mime:'audio/webm',oneAtATime:true});
  expect(r.single).toBe(true);
  expect(r.parts).toHaveLength(3);
  for(const t of r.parts)expect(t).toMatch(/^INIT\d+;/);
});
test('5c: CJ_CHUNK_MS also read from localStorage cj_chunk_ms',async({page})=>{
  await seed(page);await page.goto('/');
  expect(await page.evaluate(async()=>{localStorage.cj_chunk_ms='1234';const {Recorder}=await import('/js/recorder.js');return new Recorder().chunkMs})).toBe(1234);
});

test('6: 429,429,200 succeeds with no taps; waits per retry-after; status is visible',async({page})=>{
  await seed(page);
  let n=0;const at=[];
  await page.route('**/audio/transcriptions',r=>{at.push(Date.now());++n<=2?r.fulfill({status:429,headers:{'retry-after':'1'},json:{error:{message:'slow'}}}):r.fulfill({json:{text:'rice please'}})});
  await chatOK(page);
  await page.goto('/');
  await rec(page);                                      // the only interaction
  await expect(page.locator('#netstatus')).toContainText(/busy.*Trying again in/);
  await expect(page.locator('#name')).toHaveValue('Machboos',{timeout:15000});
  expect(n).toBe(3);
  expect(at[1]-at[0]).toBeGreaterThanOrEqual(900);      // honoured retry-after: 1
  expect(at[2]-at[1]).toBeGreaterThanOrEqual(900);
  await expect(page.locator('#netstatus')).toBeHidden();
  await expect(page.locator('#error')).toBeHidden();
  expect(await page.evaluate(()=>import('/js/groq.js').then(g=>[g.backoffSeconds(new Headers(),1),g.backoffSeconds(new Headers(),3),g.backoffSeconds(new Headers({'retry-after':'7'}),1),g.backoffSeconds(new Headers({'retry-after':'999'}),1)]))).toEqual([2,8,7,60]);
});

test('6b: still 429 after all tries -> queued in IndexedDB, retried automatically later, text kept',async({page})=>{
  await seed(page);
  await page.addInitScript(()=>{window.CJ_MAX_TRIES=2;window.CJ_QUEUE_MS=1500});
  let ok=false,calls=0;
  await page.route('**/audio/transcriptions',r=>{calls++;ok?r.fulfill({json:{text:'rice please'}}):r.fulfill({status:429,headers:{'retry-after':'1'},json:{error:{message:'slow'}}})});
  await chatOK(page);
  await page.goto('/');
  await rec(page);
  await expect(page.locator('#error')).toContainText('rate limit');
  await expect(page.locator('#pending')).toContainText('retry automatically');
  expect((await liveOf(page)).status).toBe('queued');
  expect(calls).toBe(2);
  ok=true;                                              // limit lifts; the queue notices on its own
  await expect.poll(async()=>(await liveOf(page)).status,{timeout:15000}).toBe('new');
  const callsAfter=calls;
  expect(await page.evaluate(async()=>(await (await import('/js/db.js')).listPending())[0].texts)).toEqual(['rice please']);
  await page.click('#pending .retry');                  // finishing needs no new Whisper call
  await expect(page.locator('#name')).toHaveValue('Machboos');
  expect(calls).toBe(callsAfter);
});
