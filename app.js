import * as db from './js/db.js';
import * as groq from './js/groq.js';
import {Recorder} from './js/recorder.js';
import {$,esc,showError,clearError,keyMissingMsg,stars,fmtTime} from './js/ui.js';
import * as game from './js/game.js';
import * as sound from './js/sound.js';
import {celebrate} from './js/fx.js';
import {progressChart} from './js/chart.js';

const app=$('#app');
let recorder=null;       // active Recorder
let draft=null;          // {name,ingredients,steps,transcript,parts,long}
let afterDraft=null;     // {versionId,rating,notes,transcript,parts}
const urls=[];

const fail=e=>showError(e.message==='NO_KEY'?keyMissingMsg:esc(e.message));
const busy=msg=>{app.innerHTML=`<div class="busy" role="status">${esc(msg)}</div>`};

/* ---------- recording helper shared by all flows ---------- */
const recBox=(id,label,hint,cls='')=>`<div class="recbox ${cls}"><div class="rec-row"><button class="pause" type="button" hidden>⏸ Pause</button><button id="${id}" class="rec ${id==='rec'?'':'pill'}" type="button" aria-label="${esc(label)}">${id==='rec'?'Record':esc(label)}</button></div><div class="timer" hidden aria-live="off">0:00</div><div class="hint">${esc(hint)}</div></div>`;

/** Start/stop a session. Pause/resume happens inside the same session. onDone(parts,{long}) */
async function toggleRecord(btn,onDone){
  clearError();
  const box=btn.closest('.recbox'),pauseBtn=$('.pause',box),timer=$('.timer',box),hint=$('.hint',box);
  if(!recorder){
    if(!groq.getKey())return showError(keyMissingMsg);
    const r=new Recorder();
    try{await r.start()}catch(e){sound.play('error');return fail(e)}
    recorder=r;btn.classList.add('on');btn.textContent='Stop';
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
    const r=recorder;recorder=null;
    sound.play('stop');
    const parts=await r.stop();
    await onDone(parts,{long:r.pauses>0||parts.length>1});
  }
}
const transcribing=parts=>groq.transcribeParts(parts,(i,n)=>busy(n>1?`Transcribing part ${i} of ${n}…`:'Transcribing…'));

/* ---------- views ---------- */
function hero(){
  const g=game.load(),lvl=game.levelOf(g.xp),into=g.xp%game.XP_PER_LEVEL,streak=game.currentStreak(g);
  return `<section class="hero" aria-label="Your progress"><div class="mascot" aria-hidden="true">🧁</div>
    <div class="hero-main"><div class="lvl"><b id="level">Level ${lvl}</b><span class="chip" id="streak">🔥 ${streak} day${streak===1?'':'s'}</span></div>
    <div class="xpbar" role="progressbar" aria-label="XP to next level" aria-valuemin="0" aria-valuemax="${game.XP_PER_LEVEL}" aria-valuenow="${into}"><i style="width:${into}%"></i></div>
    <small>${into} / ${game.XP_PER_LEVEL} XP · ${g.xp} total</small></div></section>`;
}
function badgesHTML(){
  const have=new Set(game.load().badges);
  return `<h2>Badges <small class="muted">${have.size}/${game.BADGES.length}</small></h2><div class="badges">`+game.BADGES.map(b=>
    `<div class="badge ${have.has(b.id)?'got':'locked'}" title="${esc(b.desc)}"><span class="em">${have.has(b.id)?b.emoji:'🔒'}</span><small>${esc(b.name)}</small></div>`).join('')+`</div>`;
}

async function home(){
  const dishes=await db.listDishes();
  app.innerHTML=hero()+`<h1>My dishes</h1>`+(dishes.length?dishes.map(d=>`
    <a class="card" href="#/dish/${d.id}"><strong>${esc(d.name)}</strong><br><small>${d.versionCount} version${d.versionCount>1?'s':''}</small></a>`).join('')
    :`<p class="empty">No dishes yet. Tap Record and describe what you cooked.</p>`)
    +badgesHTML()
    +`<div class="dock">${recBox('rec','Record','Tap to start, tap again to stop. You can pause any time.')}</div>`;
  if(!groq.getKey())showError(keyMissingMsg);
  $('#rec').onclick=ev=>toggleRecord(ev.currentTarget,async(parts,meta)=>{
    busy('Transcribing…');
    try{
      const transcript=await transcribing(parts);
      if(!transcript)throw new Error('No speech was detected. Try recording again.');
      busy('Extracting recipe…');
      const r=await groq.extractRecipe(transcript);
      draft={name:r.dish,ingredients:r.ingredients,steps:r.steps,transcript,parts,long:meta.long};
      location.hash='#/review';
    }catch(e){sound.play('error');await route(true);fail(e)}
  });
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
  $('#discard').onclick=()=>{draft=null;location.hash='#/'};
  $('#add-more').onclick=ev=>toggleRecord(ev.currentTarget,async(parts,meta)=>{
    syncDraft();
    busy('Transcribing…');
    try{
      const transcript=await transcribing(parts);
      if(!transcript)throw new Error('No speech was detected. Try recording again.');
      busy('Adding to your dish…');
      const r=await groq.extractRecipe(transcript);
      Object.assign(draft,db.mergeRecipe(draft,r),{
        name:draft.name||r.dish,
        transcript:[draft.transcript,transcript].join('\n\n'),
        parts:[...draft.parts,...parts],long:draft.long||meta.long});
      sound.play('success');review();
    }catch(e){sound.play('error');review();fail(e)}
  });
  $('#save').onclick=async()=>{
    syncDraft();
    if(!d.name)return showError('Please enter a dish name.');
    const v=await db.saveVersion({name:d.name,ingredients:d.ingredients,steps:d.steps,transcript:d.transcript,parts:d.parts});
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

async function version(id){
  const v=await db.getVersion(+id);
  if(!v){location.hash='#/';return}
  const d=await db.getDish(v.dishId);
  const audios=(blobs,label)=>blobs.map((b,i)=>{const u=URL.createObjectURL(b);urls.push(u);
    return `${blobs.length>1?`<p class="muted part">${label} part ${i+1}</p>`:''}<audio controls src="${u}"></audio>`}).join('');
  const afterHTML=v.after?`<p><span class="stars" aria-label="Rating ${v.after.rating} of 5">${stars(v.after.rating)}</span></p><p>${esc(v.after.notes)}</p>
    ${v.after.audio?audios(v.after.parts||[v.after.audio],'Note'):''}`:'<p class="muted">Not rated yet.</p>';
  app.innerHTML=`<h1>${esc(d.name)} <small class="muted">v${v.n}</small></h1>
  <a class="link" href="#/dish/${d.id}">Progress &amp; all versions</a>
  <h2>Original recording</h2>${audios(v.parts||[v.audio],'Recording')}
  <h2>Ingredients</h2><ul>${v.ingredients.map(i=>`<li>${esc([i.amount,i.unit,i.name].filter(Boolean).join(' '))}</li>`).join('')||'<li class="muted">None</li>'}</ul>
  <h2>Steps</h2><ol>${v.steps.map(s=>`<li>${esc(s)}</li>`).join('')||'<li class="muted">None</li>'}</ol>
  <details><summary>Transcript</summary><p class="muted transcript">${esc(v.transcript)}</p></details>
  <div class="after"><h2>Still cooking?</h2>${recBox('add-more','Add to this dish','Add more ingredients or steps to this version')}</div>
  <div class="after"><h2>After eating</h2><div id="after">${afterHTML}</div>
  ${recBox('rec','Record after eating note','Tap to record how it turned out','inline')}</div>`;
  $('#add-more').onclick=ev=>toggleRecord(ev.currentTarget,async(parts,meta)=>{
    busy('Transcribing…');
    try{
      const transcript=await transcribing(parts);
      if(!transcript)throw new Error('No speech was detected. Try recording again.');
      busy('Adding to your dish…');
      const recipe=await groq.extractRecipe(transcript);
      await db.appendToVersion(v.id,{parts,transcript,recipe});
      const res=game.award('append',{long:meta.long});
      await route();celebrate(res);
    }catch(e){sound.play('error');await route(true);fail(e)}
  });
  $('#rec').onclick=ev=>toggleRecord(ev.currentTarget,async parts=>{
    busy('Transcribing…');
    try{
      const transcript=await transcribing(parts);
      if(!transcript)throw new Error('No speech was detected. Try recording again.');
      busy('Rating…');
      const r=await groq.extractRating(transcript);
      afterDraft={versionId:v.id,rating:r.rating,notes:r.notes,transcript,parts};
      route();
    }catch(e){sound.play('error');await route(true);fail(e)}
  });
}

function afterReview(){
  const a=afterDraft;
  app.innerHTML=`<h1>After eating</h1>
  <label for="rating">Rating (1–5)</label>
  <select id="rating">${[1,2,3,4,5].map(n=>`<option value="${n}" ${n===a.rating?'selected':''}>${n} – ${stars(n)}</option>`).join('')}</select>
  <label for="notes">Notes</label><textarea id="notes">${esc(a.notes)}</textarea>
  <div class="row"><button class="btn" id="save-after">Save</button><button class="btn sec" id="cancel-after">Cancel</button></div>`;
  $('#cancel-after').onclick=()=>{const id=a.versionId;afterDraft=null;location.hash='#/version/'+id;route()};
  $('#save-after').onclick=async()=>{
    const rating=+$('#rating').value;
    await db.saveAfter(a.versionId,{rating,notes:$('#notes').value.trim(),transcript:a.transcript,audio:a.parts[0],parts:a.parts});
    const res=game.award('rate',{rating});
    afterDraft=null;await route();celebrate(res);
  };
}

function settings(){
  app.innerHTML=`<h1>Settings</h1>
  <label for="key">Groq API key</label>
  <input id="key" type="password" autocomplete="off" placeholder="gsk_..." value="${esc(groq.getKey())}">
  <p class="hint">Stored only in this browser (localStorage). Never sent anywhere except Groq.</p>
  <div class="row"><button class="btn" id="save-key">Save key</button></div><p id="saved" class="muted" role="status"></p>
  <h2>Sound</h2><label class="toggle"><input type="checkbox" id="mute-setting" ${sound.isMuted()?'checked':''}> Mute sounds</label>`;
  $('#save-key').onclick=()=>{groq.setKey($('#key').value.trim());clearError();$('#saved').textContent='Saved.'};
  $('#mute-setting').onchange=e=>{sound.setMuted(e.target.checked);syncMute()};
}

function syncMute(){
  const m=sound.isMuted(),b=$('#mute');
  b.textContent=m?'🔇':'🔊';b.setAttribute('aria-pressed',m);b.setAttribute('aria-label',m?'Unmute sounds':'Mute sounds');
  const c=$('#mute-setting');if(c)c.checked=m;
}
$('#mute').onclick=()=>{sound.setMuted(!sound.isMuted());syncMute();sound.play('tap')};
syncMute();
document.addEventListener('click',e=>{if(e.target.closest('.btn,.card'))sound.play('tap')});

/* ---------- router ---------- */
async function route(keep){
  const [,page,arg]=location.hash.slice(1).split('/');
  if(recorder){recorder.stop().catch(()=>{});recorder=null}
  urls.splice(0).forEach(URL.revokeObjectURL);
  if(keep!==true)clearError();
  try{
    if(page==='review')review();
    else if(page==='settings')settings();
    else if(page==='dish')await dish(arg);
    else if(page==='version')afterDraft&&afterDraft.versionId===+arg?afterReview():await version(arg);
    else await home();
  }catch(e){fail(e)}
}
addEventListener('hashchange',()=>route());
route();
if('serviceWorker'in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});
