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
    const err=e.message==='NO_KEY'?'Add your Groq API key in Settings, then tap Retry.':e.message;
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
        parts:[...draft.parts,...parts],long:draft.long||p.long,pendingIds:[...draft.pendingIds,p.id]});
      sound.play('success');
    }else draft={name:r.dish,ingredients:r.ingredients,steps:r.steps,transcript,parts,long:p.long,pendingIds:[p.id]};
    if(location.hash==='#/review')await route();else location.hash='#/review';
  }else if(p.kind==='append'){
    busy('Adding to your dish…');
    const recipe=await groq.extractRecipe(transcript);
    await db.appendToVersion(p.targetId,{parts,transcript,recipe});
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
addEventListener('cj-install',()=>{if(!recorder&&(!location.hash||location.hash==='#/'))route(true)});
data.persist();
addEventListener('online',()=>scheduleDrain(500));
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

const installTile=()=>{
  const m=data.installMode();
  return m==='prompt'?`<button class="tile install" id="install" type="button"><strong>📲 Install the app</strong><br><small>Add it to your home screen so it opens like an app</small></button>`
    :m==='ios'?`<div class="tile install" id="install-ios"><strong>📲 Add to Home Screen</strong><br><small>Tap Share ⬆️ then “Add to Home Screen”. iPhone only keeps recordings safely for installed apps.</small></div>`:'';
};
async function home(){
  const dishes=await db.listDishes();
  app.innerHTML=hero()+`<h1>My dishes</h1>`+(dishes.length?dishes.map(d=>`
    <a class="card" href="#/dish/${d.id}"><strong>${esc(d.name)}</strong><br><small>${d.versionCount} version${d.versionCount>1?'s':''}</small></a>`).join('')
    :`<p class="empty">No dishes yet. Tap Record and describe what you cooked.</p>`)
    +`<a class="tile pantry-link" href="#/pantry"><strong>🧺 My pantry</strong><br><small>${pantry.load().length} item${pantry.load().length===1?'':'s'} · see what you can cook</small></a>`
    +installTile()
    +badgesHTML()
    +`<div class="dock">${recBox('rec','Record','Tap to start, tap again to stop. You can pause any time.')}</div>`;
  if(!groq.getKey())showError(keyMissingMsg);
  if($('#install'))$('#install').onclick=()=>data.install();
  $('#rec').onclick=ev=>toggleRecord(ev.currentTarget,{kind:'new'});
}

/** Copy the review form's current values into the draft (so re-renders keep edits). */
function syncDraft(){
  const d=draft;
  d.name=$('#name').value.trim();
  d.ingredients=[...$('#ings').children].map(r=>Object.fromEntries([...r.querySelectorAll('input')].map(i=>[i.dataset.f,i.value.trim()]))).filter(i=>i.name);
  d.steps=[...$('#steps').querySelectorAll('textarea')].map(t=>t.value.trim()).filter(Boolean);
}

function review(){
  if(!draft){location.hash='#/';return}
  const d=draft;
  app.innerHTML=`<h1>Review recipe</h1>
  <label for="name">Dish name</label><input id="name" value="${esc(d.name)}">
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
  app.onclick=e=>{if(e.target.classList.contains('x'))e.target.parentElement.remove()};
  $('#discard').onclick=async()=>{await Promise.all(d.pendingIds.map(db.deletePending));draft=null;location.hash='#/'};
  $('#add-more').onclick=ev=>toggleRecord(ev.currentTarget,{kind:'new',intoDraft:true});
  $('#save').onclick=async()=>{
    syncDraft();
    if(!d.name)return showError('Please enter a dish name.');
    const v=await db.saveVersion({name:d.name,ingredients:amounts.enrichAll(d.ingredients),steps:d.steps,transcript:d.transcript,parts:d.parts});
    await Promise.all(d.pendingIds.map(db.deletePending));
    data.persist();
    const res=game.award('dish',{newDish:v.newDish,n:v.n,long:d.long});
    draft=null;clearError();location.hash='#/version/'+v.id;celebrate(res);
  };
}

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
  app.innerHTML=`<h1>${esc(d.name)}</h1>
  <section class="panel" aria-label="Progress"><h2>Progress ⭐</h2>${progressChart(vs)}<p class="trend" id="trend">${trend}</p></section>
  <h2>Versions</h2>`+vs.slice().reverse().map(v=>`
    <a class="card" href="#/version/${v.id}"><strong>Version ${v.n}</strong>
    <br><small>${new Date(v.createdAt).toLocaleString()}${v.after?` · <span class="stars">${stars(v.after.rating)}</span>`:''}</small></a>`).join('');
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
  <h2>Original recording</h2>${hasAudio?audios(v.parts||[v.audio],'Recording')+'<button class="btn sec small" id="del-audio" type="button">Delete recording, keep recipe</button>':'<p class="muted" id="audio-gone">Recording deleted. The recipe and transcript are kept.</p>'}
  <h2>Ingredients</h2><ul>${v.ingredients.map(i=>`<li>${esc([i.amount,i.unit,i.name].filter(Boolean).join(' '))}${i.qty_num!=null&&i.qty_num!=='' ?` <small class="muted qty">(${esc(amounts.fmtQty(i))})</small>`:''}</li>`).join('')||'<li class="muted">None</li>'}</ul>
  ${diffHTML(prev,v)}
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
    }catch(e){sound.play('error');cook.err=e.message==='NO_KEY'?'Add your Groq API key in Settings to get new ideas.':e.message}
    if(location.hash==='#/pantry')out.innerHTML=cookHTML();
  };
  $('#rec').onclick=ev=>toggleRecord(ev.currentTarget,{kind:'pantry'});
}

function settings(){
  app.innerHTML=`<h1>Settings</h1>
  <label for="key">Groq API key</label>
  <input id="key" type="password" autocomplete="off" placeholder="gsk_..." value="${esc(groq.getKey())}">
  <p class="hint">Stored only in this browser (localStorage). Never sent anywhere except Groq. When you record, your voice and transcript are sent to Groq to be turned into text and a recipe.</p>
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
  $('#export').onclick=async()=>{
    try{
      const blob=await data.exportAll(),a=document.createElement('a');
      a.href=URL.createObjectURL(blob);a.download=`cooking-journal-${new Date().toISOString().slice(0,10)}.zip`;
      document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),10000);
      status('Backup saved.');
    }catch(e){status('Export failed: '+e.message)}
  };
  $('#import').onchange=async e=>{
    const f=e.target.files[0];e.target.value='';if(!f)return;
    if(!confirm('Importing replaces ALL recipes, audio, progress and pantry on this device with the backup. Continue?'))return;
    try{await data.importAll(f);status('Backup imported.');location.hash='#/';location.reload()}
    catch(e){status('Import failed: '+e.message)}
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
    else if(page==='settings')settings();
    else if(page==='pantry')await pantryView();
    else if(page==='dish')await dish(arg);
    else if(page==='version')afterDraft&&afterDraft.versionId===+arg?afterReview():await version(arg);
    else await home();
  }catch(e){fail(e)}
  renderPending();
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
route().then(async()=>{if((await db.listPending()).some(p=>p.status==='queued'))scheduleDrain()});

/* ---------- one-time privacy notice ---------- */
function privacyNotice(){
  let seen=false;try{seen=localStorage.getItem('cj_notice_seen')}catch{}
  if(seen)return;
  const box=$('#notice');
  box.innerHTML=`<div class="banner" role="region" aria-label="Privacy"><strong>🔒 Your voice goes to Groq</strong><br><small>When you record, the audio is sent to Groq to be turned into text and a recipe. Recordings are also kept on this phone. Open any saved dish and tap “Delete recording, keep recipe” to remove the audio but keep the recipe.</small><div class="row"><button class="btn small" id="notice-ok" type="button">Got it</button></div></div>`;
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
if('serviceWorker'in navigator)navigator.serviceWorker.register('sw.js').then(reg=>{
  if(reg.waiting&&navigator.serviceWorker.controller)offerUpdate(reg.waiting);
  reg.addEventListener('updatefound',()=>{
    const w=reg.installing;
    w?.addEventListener('statechange',()=>{if(w.state==='installed'&&navigator.serviceWorker.controller)offerUpdate(w)});
  });
}).catch(()=>{});
