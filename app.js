import * as db from './js/db.js';
import * as groq from './js/groq.js';
import {Recorder} from './js/recorder.js';
import {$,esc,showError,clearError,keyMissingMsg,stars,fmtTime} from './js/ui.js';
import * as game from './js/game.js';
import * as sound from './js/sound.js';
import {celebrate} from './js/fx.js';
import {progressChart} from './js/chart.js';
import * as pantry from './js/pantry.js';
import * as amounts from './js/amounts.js';
import * as data from './js/data.js';
import * as receipt from './js/receipt.js';
import * as insight from './js/insight.js';

const app=$('#app');
let recorder=null;       // active Recorder
let draft=null;          // {name,ingredients,steps,transcript,parts,long,pendingIds}
let afterDraft=null;     // {versionId,rating,notes,transcript,parts,pendingId}
let activeId=null;       // pending-session id of the recording in progress
const running=new Set(); // pending ids being processed right now
const urls=[];

groq.onStatus(m=>{const el=$('#netstatus');el.textContent=m;el.hidden=!m});
const fail=e=>showError(e.message==='NO_KEY'?keyMissingMsg:esc(e.message));
const busy=msg=>{app.innerHTML=`<div class="busy" role="status">${esc(msg)}</div>`};

/* ---------- recording helper shared by all flows ---------- */
const recBox=(id,label,hint,cls='')=>`<div class="recbox ${cls}"><div class="rec-row"><button class="pause" type="button" hidden>⏸ Pause</button><button id="${id}" class="rec ${id==='rec'?'':'pill'}" type="button" aria-label="${esc(label)}">${id==='rec'?'Record':esc(label)}</button></div><div class="timer" hidden aria-live="off">0:00</div><div class="hint">${esc(hint)}</div></div>`;

/** Start/stop a session. Pause/resume happens inside the same session. onDone(parts,{long}) */
async function toggleRecord(btn,meta){
  clearError();
  const box=btn.closest('.recbox'),pauseBtn=$('.pause',box),timer=$('.timer',box),hint=$('.hint',box);
  if(!recorder){
    if(!groq.getKey())return showError(keyMissingMsg);
    const r=new Recorder();
    try{await r.start()}catch(e){sound.play('error');return fail(e)}
    // the audio goes to IndexedDB as soon as each chunk exists, so nothing depends on the network or this page staying open
    const p=await db.createPending(meta);
    r.q=Promise.resolve();
    r.onChange=(parts,live)=>{r.q=r.q.then(()=>db.patchPending(p.id,{parts,live})).catch(()=>{})};
    activeId=p.id;recorder=r;btn.classList.add('on');btn.textContent='Stop';
    document.querySelectorAll('.rec').forEach(b=>{if(b!==btn)b.disabled=true});
    pauseBtn.hidden=false;timer.hidden=false;box.classList.add('live');
    if(meta.kind==='new'||meta.kind==='append')markUI(r,p.id,box,timer);
    hint.textContent='Recording… tap Pause for a break, Stop when done';
    sound.play('start');
    const tick=setInterval(()=>{if(recorder!==r)return clearInterval(tick);timer.textContent=fmtTime(r.seconds)},250);
    pauseBtn.onclick=()=>{
      if(r.paused){r.resume();pauseBtn.textContent='⏸ Pause';box.classList.remove('paused');hint.textContent='Recording… tap Pause for a break, Stop when done';sound.play('resume')}
      else{r.pause();pauseBtn.textContent='▶ Resume';box.classList.add('paused');hint.textContent='Paused. Tap Resume to keep going in the same session';sound.play('pause')}
    };
  }else{
    const r=recorder,id=activeId;recorder=null;activeId=null;
    sound.play('stop');
    if(!await finalizeRecording(r,id))return showError('No audio was captured. Try again.');
    await runPending(id);
  }
}
/** F5: "Mark" while recording. Adds {t:seconds,text} to r.marks, saved with the pending session as it happens. */
function markUI(r,pid,box,timer){
  r.marks=[];
  const row=document.createElement('div');row.className='markrow';
  row.innerHTML='<button class="btn sec small mark" type="button">📍 Mark</button><input class="marktext" maxlength="200" placeholder="Quick note (optional)" aria-label="Quick note for this mark" hidden>';
  timer.after(row);
  const btn=$('.mark',row),inp=$('.marktext',row),save=()=>{r.q=r.q.then(()=>db.patchPending(pid,{marks:r.marks.map(m=>({...m}))})).catch(()=>{})};
  btn.onclick=()=>{
    r.marks.push({t:r.seconds,text:''});save();
    btn.textContent=`📍 Mark (${r.marks.length})`;inp.value='';inp.hidden=false;inp.focus();
    sound.play('tap');
  };
  inp.onchange=()=>{r.marks.at(-1).text=inp.value.trim();save();inp.hidden=true};
  inp.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();inp.blur()}};
}
const marksHTML=(marks,id='')=>marks?.length?`<ul class="marks"${id?` id="${id}"`:''}>${marks.map(m=>`<li><b>${fmtTime(m.t)}</b>${m.text?' '+esc(m.text):''}</li>`).join('')}</ul>`:'';
/** F4: banner with her last "next time" note for a dish (by name). Empty string when there is none. */
async function lastNoteHTML(name){
  const d=name&&await db.findDish(name);if(!d)return '';
  const n=insight.lastNote(await db.listVersions(d.id));if(!n)return '';
  return `<div class="banner lastnote" id="lastnote" role="note">📝 Last time (v${n.n}, ${stars(n.rating)}): “${esc(n.notes)}”</div>`;
}
/** Stop a recorder and store its final parts in its pending session. Returns the parts, or null if there was no audio. */
async function finalizeRecording(r,id){
  let parts=[];
  try{parts=await r.stop();await r.q}catch{}
  if(!parts.length){await db.deletePending(id);return null}
  await db.patchPending(id,{parts,live:null,status:'new',long:r.pauses>0||parts.length>1});
  return parts;
}

/* ---------- pending sessions: transcribe -> extract -> hand over, resumable at every step ---------- */
const KIND_LABEL={new:'New recipe',append:'Addition to a dish',after:'After-eating note',pantry:'Pantry list'};
const permanent=e=>!(e.status===429||e.network);
async function runPending(id,{background=false}={}){
  if(running.has(id))return;
  running.add(id);renderPending();
  try{
    const p=await db.getPending(id);
    if(!p)return;
    const parts=[...p.parts,...(p.live?[p.live]:[])],texts=p.texts.slice();
    for(let i=0;i<parts.length;i++){
      if(texts[i]!=null)continue;                       // already transcribed on an earlier try
      if(!background)busy(parts.length>1?`Transcribing part ${i+1} of ${parts.length}…`:'Transcribing…');
      texts[i]=await groq.transcribe(parts[i],texts.filter(Boolean).join(' '));
      await db.patchPending(id,{texts});                // keep it so a retry never pays twice
    }
    if(background){await db.patchPending(id,{status:'new',error:''});return}
    const transcript=texts.filter(Boolean).join(' ');
    if(!transcript)throw new Error('No speech was detected. Try recording again.');
    await finishPending(p,parts,transcript);
  }catch(e){
    const err=e.message==='NO_KEY'?'Add your AI key in Settings, then tap Retry.':e.message;
    await db.patchPending(id,{status:permanent(e)?'error':'queued',error:err}).catch(()=>{});
    if(!background){sound.play('error');await route(true);fail(e)}
    scheduleDrain();
  }finally{running.delete(id);renderPending()}
}
async function finishPending(p,parts,transcript){
  if(p.kind==='new'){
    const into=p.intoDraft&&draft;
    if(into&&$('#name'))syncDraft();
    busy(into?'Adding to your dish…':'Extracting recipe…');
    const r=await groq.extractRecipe(transcript);
    if(into){
      Object.assign(draft,db.mergeRecipe(draft,r),{name:draft.name||r.dish,transcript:[draft.transcript,transcript].join('\n\n'),
        parts:[...draft.parts,...parts],long:draft.long||p.long,pendingIds:[...draft.pendingIds,p.id],marks:[...(draft.marks||[]),...(p.marks||[])]});
      sound.play('success');
    }else{draft={name:newFor?.name||r.dish,ingredients:r.ingredients,steps:r.steps,transcript,parts,long:p.long,pendingIds:[p.id],marks:p.marks||[]};newFor=null}
    persistDraft();
    if(location.hash==='#/review')await route();else location.hash='#/review';
  }else if(p.kind==='append'){
    busy('Adding to your dish…');
    const recipe=await groq.extractRecipe(transcript);
    await db.appendToVersion(p.targetId,{parts,transcript,recipe,marks:p.marks||[]});
    await db.deletePending(p.id);
    const res=game.award('append',{long:p.long});
    await route();celebrate(res);
  }else if(p.kind==='after'){
    busy('Rating…');
    const r=await groq.extractRating(transcript);
    afterDraft={versionId:p.targetId,rating:r.rating,notes:r.notes,transcript,parts,pendingId:p.id};
    if(location.hash==='#/version/'+p.targetId)await route();else location.hash='#/version/'+p.targetId;
  }else{
    busy('Reading your list…');
    const items=await groq.extractPantry(transcript);
    const added=pantry.add(items);
    heard=transcript;
    await db.deletePending(p.id);
    sound.play('success');
    if(location.hash==='#/pantry')await route(true);else location.hash='#/pantry';
    if(!added.length)showError(items.length?'Everything you said is already in your pantry.':'Nothing new heard. Try again?');
  }
}
/** Sessions that hit a rate limit or the network are retried automatically later, and when the network comes back. */
let drainTimer=null;
function scheduleDrain(ms=window.CJ_QUEUE_MS||30000){
  if(drainTimer)return;
  drainTimer=setTimeout(async()=>{
    drainTimer=null;
    for(const p of await db.listPending())if(p.status==='queued'&&p.id!==activeId)await runPending(p.id,{background:true});
  },ms);
}
addEventListener('cj-install',renderInstall);
data.persist();
addEventListener('online',()=>scheduleDrain(500));
function renderTabs(){
  const [,page]=location.hash.slice(1).split('/');
  const cur=page==='dishes'||page==='dish'||page==='version'||page==='review'?'dishes':page==='pantry'?'pantry':page==='me'||page==='settings'?'me':'home';
  document.querySelectorAll('#tabs [data-tab]').forEach(t=>{const on=t.dataset.tab===cur;t.classList.toggle('on',on);on?t.setAttribute('aria-current','page'):t.removeAttribute('aria-current')});
}
$('#tab-rec').onclick=()=>{
  const r=$('#rec'),t=$('#typed');
  if(t&&(location.hash===''||location.hash==='#/')){t.focus();return}
  if(r&&(location.hash===''||location.hash==='#/'||location.hash==='#/pantry'))r.click();else location.hash='#/';
};
renderInstall();
async function renderPending(){
  const box=$('#pending');
  const hidden=new Set([...(draft?.pendingIds||[]),afterDraft?.pendingId]);
  const list=(await db.listPending()).filter(p=>p.id!==activeId&&!hidden.has(p.id));
  box.innerHTML=list.map(p=>{
    const n=p.parts.length+(p.live?1:0),busyNow=running.has(p.id);
    const state=busyNow?'Working on it…':p.status==='queued'?'Waiting to retry automatically':p.status==='error'?'Needs a retry':p.status==='recording'?'Recording was interrupted, audio is safe':'Recorded, not processed yet';
    return `<div class="banner pend" data-id="${p.id}"><strong>🎙️ ${KIND_LABEL[p.kind]}</strong> <small>${n} part${n===1?'':'s'} · ${state}</small>${p.error?`<br><small>${esc(p.error)}</small>`:''}
    <div class="row"><button class="btn small retry" type="button" ${busyNow?'disabled':''}>${p.status==='new'||p.status==='recording'?'Process':'Retry'}</button><button class="btn sec small drop" type="button" ${busyNow?'disabled':''}>Discard</button></div></div>`}).join('');
}
$('#pending').onclick=async e=>{
  const row=e.target.closest('.pend'),b=e.target.closest('button');if(!row||!b)return;
  const id=+row.dataset.id;
  if(b.classList.contains('drop')){await db.deletePending(id);renderPending()}
  else if(b.classList.contains('retry')){clearError();await runPending(id)}
};

/* ---------- views ---------- */
function hero(){
  const g=game.load(),lvl=game.levelOf(g.xp),into=g.xp%game.XP_PER_LEVEL,streak=game.currentStreak(g);
  return `<section class="hero" aria-label="Your progress"><div class="mascot" aria-hidden="true">🧁</div>
    <div class="hero-main"><div class="lvl"><b id="level">Level ${lvl}</b><span class="chip" id="streak">🔥 ${streak} week${streak===1?'':'s'}</span></div>
    <div class="xpbar" role="progressbar" aria-label="XP to next level" aria-valuemin="0" aria-valuemax="${game.XP_PER_LEVEL}" aria-valuenow="${into}"><i style="width:${into}%"></i></div>
    <small>${into} / ${game.XP_PER_LEVEL} XP · ${g.xp} total</small></div></section>`;
}
function badgesHTML(){
  const have=new Set(game.load().badges);
  return `<h2>Badges <small class="muted">${have.size}/${game.BADGES.length}</small></h2><div class="badges">`+game.BADGES.map(b=>
    `<div class="badge ${have.has(b.id)?'got':'locked'}" title="${esc(b.desc)}"><span class="em">${have.has(b.id)?b.emoji:'🔒'}</span><small>${esc(b.name)}</small></div>`).join('')+`</div>`;
}

/* install: a small icon button in the header (Chrome prompt) or a tiny hint (iOS) */
function renderInstall(){
  const m=data.installMode(),b=$('#install');
  b.hidden=!m;b.dataset.mode=m||'';
  if(!m)$('#install-ios').hidden=true;
}
$('#install').onclick=()=>{
  if(data.installMode()==='prompt')data.install();
  else{const t=$('#install-ios');t.hidden=!t.hidden}
};
const dishStatus=d=>d.status==='finished'?'finished':'planning';
const dishCard=d=>`<a class="card dishcard" href="#/dish/${d.id}"><strong>${esc(d.name)}</strong> <span class="status ${dishStatus(d)}">${d.status==='finished'?'✅ Finished':'📝 Planning'}</span><br><small>${d.versionCount} version${d.versionCount>1?'s':''}</small></a>`;
let recMode=null; // 'speak' | 'type'
let newFor=null; // {id,name}: the cook chose "New version" on a dish page
const TYPED_MAX=60000;
async function typedRecipe(text){
  clearError();
  if(!groq.getKey())return showError(keyMissingMsg);
  busy('Extracting recipe…');
  try{
    const r=await groq.extractRecipe(text);
    draft={name:newFor?.name||r.dish,ingredients:r.ingredients,steps:r.steps,transcript:text,parts:[],long:text.length>1500,pendingIds:[],typed:true,marks:[]};newFor=null;
    persistDraft();await db.clearTyped();
    sound.play('success');location.hash='#/review';
  }catch(e){sound.play('error');await home();fail(e)} // the text stays in the box
}
async function home(){
  const all=await db.listDishes(),dishes=all.slice(0,3);
  const saved=await db.loadTyped().catch(()=>'');
  if(recMode==null)recMode=saved?'type':'speak';
  const seg=`<div class="seg" role="group" aria-label="How do you want to add a dish?"><button type="button" id="m-speak" aria-pressed="${recMode==='speak'}">🎙️ Speak</button><button type="button" id="m-type" aria-pressed="${recMode==='type'}">⌨️ Type</button></div>`;
  const input=recMode==='type'
    ?`<div class="typebox"><label for="typed">Paste or type what you cooked</label><textarea id="typed" maxlength="${TYPED_MAX}" placeholder="e.g. Today I made machboos: 2 cups rice, a chicken, onions…" autocomplete="off">${esc(saved)}</textarea><small class="hint" id="typed-count"></small><div class="row"><button class="btn" id="typed-go" type="button">Make recipe</button><button class="btn sec" id="typed-clear" type="button">Clear</button></div></div>`
    :`<div class="bigrec">${recBox('rec','Record','Tap to start, tap again to stop. You can pause any time.')}</div>`;
  const nf=newFor?`<div class="banner newfor" id="newfor">➕ New version of <strong>${esc(newFor.name)}</strong> <button class="x" id="newfor-x" type="button" aria-label="Cancel new version">✕</button></div>`:'';
  app.innerHTML=hero()+nf+`<div id="lastnote-box">${newFor?await lastNoteHTML(newFor.name):''}</div>`+seg+input+`
  <h2>Recent dishes <a class="link more" href="#/dishes">See all</a></h2>`+(dishes.length?`<div class="recent">${dishes.map(dishCard).join('')}</div>`
    :`<p class="empty">No dishes yet. Tap Record and describe what you cooked.</p>`);
  if(!groq.getKey())showError(keyMissingMsg);
  if($('#newfor-x'))$('#newfor-x').onclick=()=>{newFor=null;home()};
  $('#m-speak').onclick=()=>{recMode='speak';home()};
  $('#m-type').onclick=()=>{recMode='type';home()};
  if(recMode==='type'){
    const t=$('#typed'),cnt=$('#typed-count'),upd=()=>{cnt.textContent=t.value.length?`${t.value.length} characters`:''};
    upd();
    let shown=newFor?.id;
    t.oninput=async()=>{
      upd();db.saveTyped(t.value).catch(()=>{});
      if(newFor)return; // the banner for the chosen dish stays
      const low=t.value.toLowerCase(),hit=all.filter(d=>d.name.length>=3&&low.includes(d.name.toLowerCase())).sort((a,b)=>b.name.length-a.name.length)[0];
      if((hit?.id)===shown)return;
      shown=hit?.id;const html=hit?await lastNoteHTML(hit.name):'';
      if(shown===hit?.id&&$('#lastnote-box'))$('#lastnote-box').innerHTML=html;
    };
    if(t.value)t.oninput();
    $('#typed-clear').onclick=async()=>{t.value='';upd();await db.clearTyped();t.focus()};
    $('#typed-go').onclick=()=>{
      const v=t.value.trim();
      if(!v)return showError('Type or paste what you cooked first.');
      typedRecipe(v);
    };
  }else $('#rec').onclick=ev=>toggleRecord(ev.currentTarget,{kind:'new'});
}
let dishFilter='all';
async function dishesView(){
  const all=await db.listDishes(),n=s=>all.filter(d=>d.status===s).length;
  const chip=(k,l,c)=>`<button class="fchip${dishFilter===k?' on':''}" type="button" data-f="${k}" aria-pressed="${dishFilter===k}">${l} <small>${c}</small></button>`;
  const list=all.filter(d=>dishFilter==='all'||d.status===dishFilter);
  app.innerHTML=`<h1>My dishes</h1><div class="filters" role="group" aria-label="Filter dishes">${chip('all','All',all.length)}${chip('finished','✅ Finished',n('finished'))}${chip('planning','📝 Planning',n('planning'))}</div>
  <p class="hint" id="status-hint">A dish becomes ✅ finished once you rate it.</p>
  <div id="dlist">${list.length?list.map(dishCard).join(''):`<p class="empty">${all.length?'No dishes in this group.':'No dishes yet. Tap Record and describe what you cooked.'}</p>`}</div>`;
  $('.filters').onclick=e=>{const b=e.target.closest('.fchip');if(b){dishFilter=b.dataset.f;dishesView()}};
}
async function meView(){
  app.innerHTML='<h1>Me</h1>'+hero()+badgesHTML()+'<div id="settings"></div>';
  settings($('#settings'));
}

/** Copy the review form's current values into the draft (so re-renders keep edits). */
function syncDraft(){
  const d=draft;
  d.name=$('#name').value.trim();
  d.ingredients=[...$('#ings').children].map(r=>Object.fromEntries([...r.querySelectorAll('input')].map(i=>[i.dataset.f,i.value.trim()]))).filter(i=>i.name);
  d.steps=[...$('#steps').querySelectorAll('textarea')].map(t=>t.value.trim()).filter(Boolean);
}
const persistDraft=()=>{if(draft)db.saveDraft(draft).catch(()=>{})};

function review(){
  if(!draft){location.hash='#/';return}
  const d=draft;
  app.innerHTML=`<h1>Review recipe</h1>
  <label for="name">Dish name</label><input id="name" value="${esc(d.name)}"><div id="lastnote-box"></div>
  ${d.marks?.length?`<h2>Your marks 📍</h2>${marksHTML(d.marks,'marks')}`:''}
  <h2>Ingredients</h2><div id="ings"></div>
  <button class="btn sec small" id="add-ing" type="button">+ Add ingredient</button>
  <h2>Steps</h2><div id="steps"></div>
  <button class="btn sec small" id="add-step" type="button">+ Add step</button>
  <h2>Transcript</h2><p class="muted transcript">${esc(d.transcript)}</p>
  <div class="after"><h2>Still cooking?</h2>${recBox('add-more','Add to this dish','Keep talking and it gets added to this dish')}</div>
  <div class="row"><button class="btn" id="save">Save</button><button class="btn sec" id="discard">Discard</button></div>`;
  const ings=$('#ings'),steps=$('#steps');
  const ingRow=i=>`<div class="ing"><input data-f="name" placeholder="Ingredient" aria-label="Ingredient name" value="${esc(i.name)}"><input data-f="amount" placeholder="Amt" aria-label="Amount" value="${esc(i.amount)}"><input data-f="unit" placeholder="Unit" aria-label="Unit" value="${esc(i.unit)}"><button class="x" type="button" aria-label="Remove ingredient">✕</button></div>`;
  const stepRow=s=>`<div class="step"><textarea aria-label="Step">${esc(s)}</textarea><button class="x" type="button" aria-label="Remove step">✕</button></div>`;
  ings.innerHTML=d.ingredients.map(ingRow).join('');
  steps.innerHTML=d.steps.map(stepRow).join('');
  $('#add-ing').onclick=()=>ings.insertAdjacentHTML('beforeend',ingRow({name:'',amount:'',unit:''}));
  $('#add-step').onclick=()=>steps.insertAdjacentHTML('beforeend',stepRow(''));
  let ln=0;
  const showLast=async()=>{const n=++ln,h=await lastNoteHTML($('#name')?.value);if(n===ln&&$('#lastnote-box'))$('#lastnote-box').innerHTML=h};
  showLast();$('#name').addEventListener('input',showLast);
  const edit=()=>{if(draft===d&&$('#name')){syncDraft();persistDraft()}};
  app.oninput=edit;
  app.onclick=e=>{if(e.target.classList.contains('x')){e.target.parentElement.remove();edit()}};
  $('#discard').onclick=async()=>{await Promise.all(d.pendingIds.map(db.deletePending));await db.clearDraft();draft=null;location.hash='#/'};
  $('#add-more').onclick=ev=>toggleRecord(ev.currentTarget,{kind:'new',intoDraft:true});
  $('#save').onclick=async()=>{
    syncDraft();
    if(!d.name)return showError('Please enter a dish name.');
    const v=await db.saveVersion({name:d.name,ingredients:amounts.enrichAll(d.ingredients),steps:d.steps,transcript:d.transcript,parts:d.parts,typed:!!d.typed,marks:d.marks||[]});
    await Promise.all(d.pendingIds.map(db.deletePending));await db.clearDraft();
    data.persist();
    const res=game.award('dish',{newDish:v.newDish,n:v.n,long:d.long});
    draft=null;clearError();
    const used=insight.usedFromPantry(v.ingredients,pantry.load());
    if(used.length)useUp(v,res,used);
    else{location.hash='#/version/'+v.id;celebrate(res)}
  };
}

/** F3: after saving, offer to remove pantry items that went into the dish. Nothing is removed unless ticked. */
function useUp(v,res,used){
  app.onclick=app.oninput=null;
  app.innerHTML=`<h1>Saved! 🎉</h1><div class="card rc"><h2>Use up from pantry?</h2><p class="hint">Tick what you used up. Only ticked items are removed from your pantry.</p><ul class="rclist" id="useup">${used.map((p,i)=>`<li><label><input type="checkbox" data-i="${i}"> <span class="rn">${esc(p)}</span></label></li>`).join('')}</ul>
  <div class="row"><button class="btn small" id="useup-go" type="button"></button><button class="btn sec small" id="useup-skip" type="button">Skip</button></div></div>`;
  const upd=()=>{const n=app.querySelectorAll('#useup input:checked').length;$('#useup-go').textContent=`Remove ${n} from pantry`;$('#useup-go').disabled=!n};
  upd();$('#useup').onchange=upd;
  const done=()=>{location.hash='#/version/'+v.id;celebrate(res)};
  $('#useup-go').onclick=()=>{[...app.querySelectorAll('#useup input:checked')].forEach(c=>pantry.remove(used[+c.dataset.i]));sound.play('success');done()};
  $('#useup-skip').onclick=done;
}

/** F1: "Why was vN better?" card. The AI sentence is cached on the version; offline or no key = card without it. */
async function whyCard(w){
  const q=i=>esc([amounts.fmtQty(i)||[i.amount,i.unit].filter(Boolean).join(' '),i.name].filter(Boolean).join(' '));
  const {added,removed,changed}=w.diff;
  const rows=[...added.map(i=>`<li class="d-add">+ ${q(i)}</li>`),...removed.map(i=>`<li class="d-rem">− ${q(i)}</li>`),
    ...changed.map(c=>`<li class="d-chg">~ ${esc(c.to.name)}: ${esc(amounts.fmtQty(c.from)||'?')} → ${esc(amounts.fmtQty(c.to)||'?')}</li>`)];
  const note=String(w.best.after.notes||'').trim();
  const cached=w.best.why?.key===w.key?w.best.why.text:'';
  return `<section class="panel why" id="why" aria-label="Why was v${w.best.n} better"><h2>Why was v${w.best.n} better? ✨</h2>
    <p class="muted">v${w.best.n} got ${stars(w.best.after.rating)}${w.prev.after?`, v${w.prev.n} got ${stars(w.prev.after.rating)}`:`, v${w.prev.n} was not rated`}.</p>
    ${rows.length?`<ul id="why-diff">${rows.join('')}</ul>`:'<p class="muted" id="why-diff">Same ingredients and amounts.</p>'}
    ${note?`<p id="why-note">Your note: “${esc(note)}”</p>`:''}<p id="why-ai" class="why-ai">${esc(cached)}</p></section>`;
}
async function whyAI(w,dishName,dishId){
  if(w.best.why?.key===w.key||!groq.getKey())return;
  try{
    const sentence=await groq.explainBetter({dish:dishName,better:{version:w.best.n,rating:w.best.after.rating,notes:w.best.after.notes||''},previous:{version:w.prev.n,rating:w.prev.after?.rating??null},
      changes:{added:w.diff.added.map(i=>i.name),removed:w.diff.removed.map(i=>i.name),changed:w.diff.changed.map(c=>({name:c.to.name,from:amounts.fmtQty(c.from),to:amounts.fmtQty(c.to)}))}});
    if(!sentence)return;
    await db.patchVersion(w.best.id,{why:{key:w.key,text:sentence}});
    if(location.hash==='#/dish/'+dishId&&$('#why-ai'))$('#why-ai').textContent=sentence;
  }catch{} // offline / rate limit: just no sentence
}

/** F2: checklist for cooking the best version, with grams and what the pantry is missing. */
async function cookView(id){
  const d=await db.getDish(+id);
  const v=d&&insight_best(await db.listVersions(d.id));
  if(!v){location.hash='#/dishes';return}
  const ings=amounts.enrichAll(v.ingredients),miss=new Set(pantry.missing(ings.map(i=>i.name)));
  app.innerHTML=`<h1>Cook ${esc(d.name)} <small class="muted">v${v.n}${v.after?' · '+stars(v.after.rating):''}</small></h1>
  <a class="link" href="#/dish/${d.id}">Back to ${esc(d.name)}</a>
  <div id="cook-miss">${miss.size?`<p class="miss">Not in your pantry: ${[...miss].map(esc).join(', ')}</p>`:'<p class="miss ok">Your pantry has everything! 🎉</p>'}</div>
  <h2>Ingredients</h2><ul class="rclist" id="cl-ings">${ings.map(i=>{
    const g=amounts.fmtQty(i),has=!miss.has(i.name);
    return `<li class="${has?'':'lack'}"><label><input type="checkbox"> <span class="rn">${esc(i.name)}</span> <small class="muted">${esc(g||[i.amount,i.unit].filter(Boolean).join(' '))}</small>${has?'':' <span class="flag" title="Not in your pantry">🛒 missing</span>'}</label></li>`}).join('')||'<li class="muted">No ingredients saved.</li>'}</ul>
  <h2>Steps</h2><ol class="rclist" id="cl-steps">${v.steps.map(s=>`<li><label><input type="checkbox"> ${esc(s)}</label></li>`).join('')||'<li class="muted">None</li>'}</ol>`;
}
const insight_best=pantry.bestVersion;

async function dish(id){
  const d=await db.getDish(+id);
  if(!d){location.hash='#/';return}
  const vs=await db.listVersions(d.id);
  const rated=vs.filter(v=>v.after);
  let trend='Rate a version after eating to see your progress.';
  if(rated.length>=2){
    const diff=rated.at(-1).after.rating-rated[0].after.rating;
    trend=diff>0?`Up ${diff}★ since v${rated[0].n}! Keep going 🎉`:diff<0?`Down ${-diff}★ since v${rated[0].n}. Time to tweak 🔧`:`Steady at ${rated.at(-1).after.rating}★ since v${rated[0].n}.`;
  }else if(rated.length===1)trend='One rating so far. Cook it again to see a trend!';
  const w=insight.whyBetter(vs);
  app.innerHTML=`<h1>${esc(d.name)}</h1>
  <div class="row"><a class="btn small" id="cook-best" href="#/cook/${d.id}">🍳 Cook my best version</a><button class="btn sec small" id="new-ver" type="button">➕ New version</button></div>
  ${w?await whyCard(w):''}
  <section class="panel" aria-label="Progress"><h2>Progress ⭐</h2>${progressChart(vs)}<p class="trend" id="trend">${trend}</p></section>
  <h2>Versions</h2>`+vs.slice().reverse().map(v=>`
    <a class="card" href="#/version/${v.id}"><strong>Version ${v.n}</strong>
    <br><small>${new Date(v.createdAt).toLocaleString()}${v.after?` · <span class="stars">${stars(v.after.rating)}</span>`:''}</small></a>`).join('');
  $('#new-ver').onclick=()=>{newFor={id:d.id,name:d.name};recMode='speak';location.hash='#/'};
  if(w)whyAI(w,d.name,d.id);
}

function diffHTML(prev,v){
  if(!prev)return '';
  const d=amounts.diffIngredients(prev.ingredients,v.ingredients),q=i=>esc([amounts.fmtQty(i)||[i.amount,i.unit].filter(Boolean).join(' '),i.name].filter(Boolean).join(' '));
  const rows=[...d.added.map(i=>`<li class="d-add">+ ${q(i)}</li>`),...d.removed.map(i=>`<li class="d-rem">− ${q(i)}</li>`),
    ...d.changed.map(c=>`<li class="d-chg">~ ${esc(c.to.name)}: ${esc(amounts.fmtQty(c.from)||'?')} → ${esc(amounts.fmtQty(c.to)||'?')}</li>`)];
  return `<details class="diff" open><summary>Changes since v${prev.n}</summary>${rows.length?`<ul id="diff">${rows.join('')}</ul>`:'<p class="muted" id="diff">Same ingredients and amounts.</p>'}</details>`;
}
async function version(id){
  const v=await db.getVersion(+id);
  if(!v){location.hash='#/';return}
  const d=await db.getDish(v.dishId);
  const prev=v.n>1?(await db.listVersions(v.dishId)).find(x=>x.n===v.n-1):null;
  const audios=(blobs,label)=>blobs.map((b,i)=>{const u=URL.createObjectURL(b);urls.push(u);
    return `${blobs.length>1?`<p class="muted part">${label} part ${i+1}</p>`:''}<audio controls src="${u}"></audio>`}).join('');
  const hasAudio=(v.parts||[v.audio]).some(Boolean);
  const afterHTML=v.after?`<p><span class="stars" aria-label="Rating ${v.after.rating} of 5">${stars(v.after.rating)}</span></p><p>${esc(v.after.notes)}</p>
    ${v.after.audio&&v.after.parts?.length?audios(v.after.parts||[v.after.audio],'Note'):''}`:'<p class="muted">Not rated yet.</p>';
  app.innerHTML=`<h1>${esc(d.name)} <small class="muted">v${v.n}</small></h1>
  <a class="link" href="#/dish/${d.id}">Progress &amp; all versions</a>
  <h2>Original recording</h2>${hasAudio?audios(v.parts||[v.audio],'Recording')+'<button class="btn sec small" id="del-audio" type="button">Delete recording, keep recipe</button>':`<p class="muted" id="audio-gone">${v.typed&&!v.audioDeleted?'This recipe was typed in, so there is no recording. The text is under Transcript below.':'Recording deleted. The recipe and transcript are kept.'}</p>`}
  <h2>Ingredients</h2><ul>${v.ingredients.map(i=>`<li>${esc([i.amount,i.unit,i.name].filter(Boolean).join(' '))}${i.qty_num!=null&&i.qty_num!=='' ?` <small class="muted qty">(${esc(amounts.fmtQty(i))})</small>`:''}</li>`).join('')||'<li class="muted">None</li>'}</ul>
  ${diffHTML(prev,v)}
  ${v.marks?.length?`<h2>Your marks 📍</h2>${marksHTML(v.marks,'marks')}`:''}
  <h2>Steps</h2><ol>${v.steps.map(s=>`<li>${esc(s)}</li>`).join('')||'<li class="muted">None</li>'}</ol>
  <details><summary>Transcript</summary><p class="muted transcript">${esc(v.transcript)}</p></details>
  <div class="after"><h2>Still cooking?</h2>${recBox('add-more','Add to this dish','Add more ingredients or steps to this version')}</div>
  <div class="after"><h2>After eating</h2><div id="after">${afterHTML}</div>
  ${recBox('rec','Record after eating note','Tap to record how it turned out','inline')}</div>`;
  $('#add-more').onclick=ev=>toggleRecord(ev.currentTarget,{kind:'append',targetId:v.id});
  $('#rec').onclick=ev=>toggleRecord(ev.currentTarget,{kind:'after',targetId:v.id});
  if($('#del-audio'))$('#del-audio').onclick=async()=>{
    if(!confirm('Delete the audio for this version? The recipe, transcript and rating stay. This cannot be undone.'))return;
    await db.deleteAudio(v.id);await route();
  };
}

function afterReview(){
  const a=afterDraft;
  app.innerHTML=`<h1>After eating</h1>
  <label for="rating">Rating (1–5)</label>
  <select id="rating">${[1,2,3,4,5].map(n=>`<option value="${n}" ${n===a.rating?'selected':''}>${n} – ${stars(n)}</option>`).join('')}</select>
  <label for="notes">Notes</label><textarea id="notes">${esc(a.notes)}</textarea>
  <div class="row"><button class="btn" id="save-after">Save</button><button class="btn sec" id="cancel-after">Cancel</button></div>`;
  $('#cancel-after').onclick=()=>{const id=a.versionId;db.deletePending(a.pendingId);afterDraft=null;location.hash='#/version/'+id;route()};
  $('#save-after').onclick=async()=>{
    const rating=+$('#rating').value;
    await db.saveAfter(a.versionId,{rating,notes:$('#notes').value.trim(),transcript:a.transcript,audio:a.parts[0],parts:a.parts});
    const res=game.award('rate',{rating});
    await db.deletePending(a.pendingId);afterDraft=null;await route();celebrate(res);
  };
}


/* ---------- pantry ---------- */
let heard=''; // what Whisper heard in the last pantry recording
let cook=null; // last "what can I cook" result, kept while on the pantry page
const chips=()=>pantry.load().map(p=>`<li class="pchip${pantry.isUnsure(p)?' unsure':''}">${pantry.isUnsure(p)?`<button class="ok" type="button" data-name="${esc(p)}" title="Not sure I heard this right. Tap to confirm">❓</button>`:''}<span>${esc(p)}</span><button class="x" type="button" data-name="${esc(p)}" aria-label="Remove ${esc(p)}">✕</button></li>`).join('');
const missHTML=m=>m.length?`<p class="miss">Missing: ${m.map(esc).join(', ')}</p>`:`<p class="miss ok">You have everything! 🎉</p>`;
function cookHTML(){
  if(!cook)return '';
  const saved=cook.saved.map(f=>`<a class="card fit" href="#/version/${f.version.id}"><strong>${esc(f.dish.name)}</strong> <small>v${f.version.n}${f.version.after?` · <span class="stars">${stars(f.version.after.rating)}</span>`:' · not rated'}</small>${missHTML(f.missing)}</a>`).join('');
  const ideas=cook.ideas.map(i=>`<div class="card idea"><strong>💡 ${esc(i.name)}</strong><br><small>${esc(i.why)}</small>${missHTML(i.missing)}</div>`).join('');
  return `<h2>From your journal</h2>${saved||'<p class="empty">No saved dish fits yet.</p>'}<h2>New ideas</h2>${cook.err?`<p class="empty">${esc(cook.err)}</p>`:ideas||'<p class="empty">No ideas came back. Try again.</p>'}`;
}
async function pantryView(){
  app.innerHTML=`<h1>My pantry 🧺</h1>
  <form id="padd" class="padd"><input id="pitem" aria-label="Add an ingredient" placeholder="Type an ingredient…" autocomplete="off"><button class="btn small" type="submit">Add</button></form>
  <div class="receipt"><label class="btn sec small" id="rc-label">🧾 Add from receipt<input id="rc-file" type="file" accept="application/pdf,image/*" hidden></label><small class="hint"> PDF or photo</small></div><div id="rc-out" aria-live="polite"></div>
  <p id="heard" class="muted" ${heard?'':'hidden'}>Heard: “${esc(heard)}”</p><ul id="chips" class="chips" aria-label="Pantry items"></ul><p id="pempty" class="empty" hidden>Your pantry is empty. Type or record what you have.</p>
  <button class="btn big" id="cook" type="button">🍲 What can I cook?</button>
  <div id="cook-out" aria-live="polite"></div>
  <div class="dock">${recBox('rec','Record','Tap and say what you have, e.g. "rice, onions, chicken"')}</div>`;
  const render=()=>{$('#chips').innerHTML=chips();$('#pempty').hidden=pantry.load().length>0;$('#cook').disabled=!pantry.load().length};
  render();$('#cook-out').innerHTML=cookHTML();
  $('#padd').onsubmit=e=>{e.preventDefault();const v=$('#pitem').value;$('#pitem').value='';
    // allow "rice, onion" typed in one go
    if(pantry.add(v.split(/[,،\n]/)).length)sound.play('tap');render()};
  $('#chips').onclick=e=>{const o=e.target.closest('.ok');if(o){pantry.confirm(o.dataset.name);render();return}const b=e.target.closest('.x');if(!b)return;pantry.remove(b.dataset.name);sound.play('tap');render()};
  $('#cook').onclick=async()=>{
    clearError();const list=pantry.load(),out=$('#cook-out');
    out.innerHTML='<div class="busy" role="status">Looking through your journal…</div>';
    const dishes=await db.listDishes();
    const saved=pantry.fits(await Promise.all(dishes.map(async d=>({dish:d,versions:await db.listVersions(d.id)}))),list);
    cook={saved,ideas:[]};out.innerHTML=cookHTML()+'<div class="busy" role="status">Asking the chef for new ideas…</div>';
    try{
      if(!groq.getKey())throw new Error('NO_KEY');
      cook.ideas=await groq.suggestIdeas(list,dishes.map(d=>d.name));
      sound.play('success');
    }catch(e){sound.play('error');cook.err=e.message==='NO_KEY'?'Add your AI key in Settings to get new ideas.':e.message}
    if(location.hash==='#/pantry')out.innerHTML=cookHTML();
  };
  $('#rec').onclick=ev=>toggleRecord(ev.currentTarget,{kind:'pantry'});
  receiptUI(render);
}

/* ---------- pantry: add from a receipt (PDF or photo). Nothing is added until the cook ticks it. ---------- */
let rcRows=null; // checklist rows of the last receipt, kept while on the pantry page
function receiptUI(renderChips){
  const out=$('#rc-out'),seen=()=>{try{return localStorage.getItem('cj_receipt_notice_seen')}catch{return '1'}};
  const show=()=>{
    if(!rcRows){out.innerHTML='';return}
    if(!rcRows.length){out.innerHTML='<div class="card rc"><strong>No food items found on this receipt.</strong><br><small>Nothing was added. Try a clearer photo, or type the items above.</small><div class="row"><button class="btn sec small" id="rc-cancel" type="button">Close</button></div></div>';$('#rc-cancel').onclick=()=>{rcRows=null;show()};return}
    out.innerHTML=`<div class="card rc"><h2>Found on your receipt</h2><p class="hint">Tick what to add. ❓ means I am not sure, so it starts unticked.</p><ul class="rclist">`+rcRows.map((r,i)=>
      `<li class="${r.have?'have':''}"><label><input type="checkbox" data-i="${i}" ${r.checked?'checked':''} ${r.have?'disabled':''}> <span class="rn">${esc(r.name)}</span>${amounts.fmtQty({qty_num:r.qty,unit_std:r.unit,approx:r.approx})?` <small class="muted">${esc(amounts.fmtQty({qty_num:r.qty,unit_std:r.unit,approx:r.approx}))}</small>`:''}${r.unsure?' <span title="Not sure">❓</span>':''}${r.have?' <small class="muted">already in your pantry</small>':''}</label></li>`).join('')+
      `</ul><div class="row"><button class="btn small" id="rc-add" type="button"></button><button class="btn sec small" id="rc-cancel" type="button">Cancel</button></div></div>`;
    const upd=()=>{const n=rcRows.filter(r=>r.checked&&!r.have).length;const b=$('#rc-add');b.textContent=`Add ${n} to pantry`;b.disabled=!n};
    upd();
    $('.rclist').onchange=e=>{const c=e.target.closest('input[data-i]');if(c){rcRows[+c.dataset.i].checked=c.checked;upd()}};
    $('#rc-cancel').onclick=()=>{rcRows=null;show()};
    $('#rc-add').onclick=()=>{
      const added=pantry.add(rcRows.filter(r=>r.checked&&!r.have).map(r=>r.name));
      rcRows=null;show();renderChips();sound.play('success');
      out.innerHTML=`<p class="muted" role="status" id="rc-done">Added ${added.length} item${added.length===1?'':'s'} from your receipt.</p>`;
    };
  };
  const run=async f=>{
    clearError();out.innerHTML='<div class="busy" role="status">Reading your receipt…</div>';
    try{
      const r=await receipt.importReceipt(f,pantry.load());
      rcRows=r.rows.map(x=>({...x,checked:!x.unsure&&!x.have}));
      sound.play(rcRows.length?'success':'error');
    }catch(e){rcRows=null;out.innerHTML='';sound.play('error');if(location.hash==='#/pantry')fail(e);return}
    if(location.hash==='#/pantry')show();
  };
  $('#rc-file').onchange=e=>{
    const f=e.target.files[0];e.target.value='';if(!f)return;
    clearError();
    if(!groq.getKey())return showError(keyMissingMsg);
    if(seen())return run(f);
    out.innerHTML=`<div class="banner" role="region" aria-label="Privacy"><strong>🔒 Your receipt goes to an online AI service</strong><br><small>The receipt (its text, or a photo) is sent to an online AI service to find the food items. Photos are re-saved without location data first. Do not use a receipt that shows anything private you do not want shared.</small><div class="row"><button class="btn small" id="rc-ok" type="button">Send it</button><button class="btn sec small" id="rc-no" type="button">Cancel</button></div></div>`;
    $('#rc-ok').onclick=()=>{try{localStorage.setItem('cj_receipt_notice_seen','1')}catch{}run(f)};
    $('#rc-no').onclick=()=>{out.innerHTML=''};
  };
  show();
}

function settings(root){
  root.innerHTML=`<h2>Settings</h2>
  <label for="key">AI key</label>
  <input id="key" type="password" autocomplete="off" placeholder="Paste your AI key" value="${esc(groq.getKey())}">
  <p class="hint">Stored only in this browser (localStorage). Never sent anywhere except the AI service. Your voice is sent to an online AI service to turn it into text and a recipe.</p>
  <div class="row"><button class="btn" id="save-key">Save key</button><button class="btn sec" id="clear-key" type="button">Clear key</button></div><p id="saved" class="muted" role="status"></p>
  <h2>Sound</h2><label class="toggle"><input type="checkbox" id="mute-setting" ${sound.isMuted()?'checked':''}> Mute sounds</label>
  <h2>Your data</h2>
  <p class="hint">Everything lives only on this device. Export a backup zip (recipes, audio, progress, pantry; not your API key) and import it on a new phone or after clearing data.</p>
  <div class="row"><button class="btn" id="export" type="button">Export backup (.zip)</button><label class="btn sec" id="import-label">Import backup<input id="import" type="file" accept=".zip,application/zip" hidden></label></div>
  <p id="data-status" class="muted" role="status"></p><p id="persist-status" class="muted" role="status"></p>`;
  $('#save-key').onclick=()=>{groq.setKey($('#key').value.trim());clearError();$('#saved').textContent='Saved.'};
  $('#clear-key').onclick=()=>{groq.setKey('');$('#key').value='';$('#saved').textContent='Key removed from this browser.'};
  $('#mute-setting').onchange=e=>{sound.setMuted(e.target.checked);syncMute()};
  const status=m=>{$('#data-status').textContent=m};
  data.persist().then(async()=>{$('#persist-status').textContent=await data.isPersisted()?'Storage: protected from automatic cleanup.':'Storage: the browser may clear this data when space is low. Add the app to your home screen and export backups.'});
  const download=(blob,name)=>{
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);a.download=name;
    document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),10000);
  };
  $('#export').onclick=async()=>{
    try{download(await data.exportAll(),`cooking-journal-${new Date().toISOString().slice(0,10)}.zip`);status('Backup saved.')}
    catch(e){status('Export failed: '+e.message)}
  };
  $('#import').onchange=async e=>{
    const f=e.target.files[0];e.target.value='';if(!f)return;
    try{
      const i=await data.inspect(f),n=c=>`${c.dishes} dishes, ${c.sessions} sessions, ${c.pending} pending`;
      const when=i.exportedAt?new Date(i.exportedAt).toLocaleString():'unknown date';
      if(!confirm(`Import backup from ${when}?\n\nBackup: ${n(i.backup)}\nThis device now: ${n(i.current)}\n\nRecipes, audio, progress and pantry on this device will be replaced. Unfinished (pending) recordings here are kept. A safety backup of the current data is downloaded first.`))return;
      download(await data.exportAll(),`cooking-journal-before-import-${new Date().toISOString().replace(/[:.]/g,'-')}.zip`);
      await data.importAll(f);status('Backup imported.');location.hash='#/';location.reload();
    }catch(e){status('Import failed: '+e.message)}
  };
}

function syncMute(){
  const m=sound.isMuted(),b=$('#mute');
  b.textContent=m?'🔇':'🔊';b.setAttribute('aria-pressed',m);b.setAttribute('aria-label',m?'Unmute sounds':'Mute sounds');
  const c=$('#mute-setting');if(c)c.checked=m;
}
$('#mute').onclick=()=>{sound.setMuted(!sound.isMuted());syncMute();sound.play('tap')};
syncMute();
document.addEventListener('click',e=>{if(e.target.closest('.btn,.card,.tile'))sound.play('tap')});

/* ---------- router ---------- */
async function route(keep){
  const [,page,arg]=location.hash.slice(1).split('/');
  if(recorder){const r=recorder,id=activeId;recorder=null;activeId=null;await finalizeRecording(r,id)}
  urls.splice(0).forEach(URL.revokeObjectURL);
  if(keep!==true)clearError();
  try{
    if(page==='review')review();
    else if(page==='dishes')await dishesView();
    else if(page==='me'||page==='settings')await meView();
    else if(page==='pantry')await pantryView();
    else if(page==='dish')await dish(arg);
    else if(page==='cook')await cookView(arg);
    else if(page==='version')afterDraft&&afterDraft.versionId===+arg?afterReview():await version(arg);
    else await home();
  }catch(e){fail(e)}
  renderTabs();renderPending();
}
/* leaving mid-recording asks first; whatever was recorded is kept as a pending session either way */
let curHash=location.hash;
addEventListener('hashchange',()=>{
  if(location.hash===curHash)return;
  if(recorder&&!confirm('You are recording. Leave this page? Your audio so far is saved and you can process it later.')){history.replaceState(null,'',curHash||'#/');return}
  curHash=location.hash;route();
});
/* a hidden or closing page may never get another chance: ask the recorder to hand over its audio now and store it */
const flushRecording=()=>recorder?.flush();
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')flushRecording()});
addEventListener('pagehide',flushRecording);
addEventListener('beforeunload',flushRecording);
db.loadDraft().then(d=>{draft??=d},()=>{}).then(route).then(async()=>{if((await db.listPending()).some(p=>p.status==='queued'))scheduleDrain()});

/* ---------- one-time privacy notice ---------- */
function privacyNotice(){
  let seen=false;try{seen=localStorage.getItem('cj_notice_seen')}catch{}
  if(seen)return;
  const box=$('#notice');
  box.innerHTML=`<div class="banner" role="region" aria-label="Privacy"><strong>🔒 Your voice goes to an online AI service</strong><br><small>Your voice is sent to an online AI service to turn it into text and a recipe. Recordings are also kept on this phone. Open any saved dish and tap “Delete recording, keep recipe” to remove the audio but keep the recipe.</small><div class="row"><button class="btn small" id="notice-ok" type="button">Got it</button></div></div>`;
  $('#notice-ok').onclick=()=>{try{localStorage.setItem('cj_notice_seen','1')}catch{}box.innerHTML=''};
}
privacyNotice();

/* ---------- service worker + update prompt ---------- */
function offerUpdate(worker){
  if($('#update-btn'))return;
  $('#update').innerHTML=`<div class="banner" role="status"><button class="btn small" id="update-btn" type="button">New version available, tap to refresh</button></div>`;
  $('#update-btn').onclick=()=>{
    if(recorder&&!confirm('You are recording. Refresh anyway? Your audio so far is saved.'))return;
    navigator.serviceWorker.addEventListener('controllerchange',()=>location.reload(),{once:true});
    worker.postMessage('SKIP_WAITING');
  };
}
if('serviceWorker'in navigator)navigator.serviceWorker.register('sw.js',{scope:'./'}).then(reg=>{
  if(reg.waiting&&navigator.serviceWorker.controller)offerUpdate(reg.waiting);
  reg.addEventListener('updatefound',()=>{
    const w=reg.installing;
    w?.addEventListener('statechange',()=>{if(w.state==='installed'&&navigator.serviceWorker.controller)offerUpdate(w)});
  });
}).catch(()=>{});
