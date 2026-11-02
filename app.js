import * as db from './js/db.js';
import * as groq from './js/groq.js';
import {Recorder} from './js/recorder.js';
import {$,esc,showError,clearError,keyMissingMsg,stars} from './js/ui.js';

const app=$('#app');
let recorder=null;       // active Recorder
let draft=null;          // {name,ingredients,steps,transcript,audio}
let afterDraft=null;     // {versionId,rating,notes,transcript,audio}
const urls=[];

const fail=e=>showError(e.message==='NO_KEY'?keyMissingMsg:esc(e.message));
const busy=msg=>{app.innerHTML=`<div class="busy" role="status">${esc(msg)}</div>`};

/* ---------- recording helper shared by both flows ---------- */
async function toggleRecord(btn,onDone){
  clearError();
  if(!recorder){
    if(!groq.getKey())return showError(keyMissingMsg);
    const r=new Recorder();
    try{await r.start()}catch(e){return fail(e)}
    recorder=r;btn.classList.add('on');btn.textContent='Stop';
    $('.hint')&&($('.hint').textContent='Recording… tap Stop when done');
  }else{
    const r=recorder;recorder=null;
    const blob=await r.stop();
    await onDone(blob);
  }
}

/* ---------- views ---------- */
async function home(){
  const dishes=await db.listDishes();
  app.innerHTML=`<h1>My dishes</h1>`+(dishes.length?dishes.map(d=>`
    <a class="card" href="#/dish/${d.id}"><strong>${esc(d.name)}</strong><br><small>${d.versionCount} version${d.versionCount>1?'s':''}</small></a>`).join('')
    :`<p class="empty">No dishes yet. Tap Record and describe what you cooked.</p>`)
    +`<div class="dock"><button id="rec" class="rec" aria-label="Record">Record</button><div class="hint">Tap to start, tap again to stop</div></div>`;
  if(!groq.getKey())showError(keyMissingMsg);
  $('#rec').onclick=ev=>toggleRecord(ev.currentTarget,async blob=>{
    busy('Transcribing…');
    try{
      const transcript=await groq.transcribe(blob);
      if(!transcript)throw new Error('No speech was detected. Try recording again.');
      busy('Extracting recipe…');
      const r=await groq.extractRecipe(transcript);
      draft={name:r.dish,ingredients:r.ingredients,steps:r.steps,transcript,audio:blob};
      location.hash='#/review';
    }catch(e){await route(true);fail(e)}
  });
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
  <h2>Transcript</h2><p class="muted">${esc(d.transcript)}</p>
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
  $('#save').onclick=async()=>{
    const name=$('#name').value.trim();
    if(!name)return showError('Please enter a dish name.');
    const v=await db.saveVersion({
      name,
      ingredients:[...ings.children].map(r=>Object.fromEntries([...r.querySelectorAll('input')].map(i=>[i.dataset.f,i.value.trim()]))).filter(i=>i.name),
      steps:[...steps.querySelectorAll('textarea')].map(t=>t.value.trim()).filter(Boolean),
      transcript:d.transcript,audio:d.audio});
    draft=null;clearError();location.hash='#/version/'+v.id;
  };
}

async function dish(id){
  const d=await db.getDish(+id);
  if(!d){location.hash='#/';return}
  const vs=await db.listVersions(d.id);
  app.innerHTML=`<h1>${esc(d.name)}</h1>`+vs.slice().reverse().map(v=>`
    <a class="card" href="#/version/${v.id}"><strong>Version ${v.n}</strong>
    <br><small>${new Date(v.createdAt).toLocaleString()}${v.after?` · <span class="stars">${stars(v.after.rating)}</span>`:''}</small></a>`).join('');
}

async function version(id){
  const v=await db.getVersion(+id);
  if(!v){location.hash='#/';return}
  const d=await db.getDish(v.dishId);
  const url=URL.createObjectURL(v.audio);urls.push(url);
  const afterHTML=v.after?`<p><span class="stars" aria-label="Rating ${v.after.rating} of 5">${stars(v.after.rating)}</span></p><p>${esc(v.after.notes)}</p>
    ${v.after.audio?`<audio controls src="${(urls[urls.push(URL.createObjectURL(v.after.audio))-1])}"></audio>`:''}`:'<p class="muted">Not rated yet.</p>';
  app.innerHTML=`<h1>${esc(d.name)} <small class="muted">v${v.n}</small></h1>
  <a class="link" href="#/dish/${d.id}">All versions</a>
  <h2>Original recording</h2><audio controls src="${url}"></audio>
  <h2>Ingredients</h2><ul>${v.ingredients.map(i=>`<li>${esc([i.amount,i.unit,i.name].filter(Boolean).join(' '))}</li>`).join('')||'<li class="muted">None</li>'}</ul>
  <h2>Steps</h2><ol>${v.steps.map(s=>`<li>${esc(s)}</li>`).join('')||'<li class="muted">None</li>'}</ol>
  <details><summary>Transcript</summary><p class="muted">${esc(v.transcript)}</p></details>
  <div class="after"><h2>After eating</h2><div id="after">${afterHTML}</div>
  <button id="rec" class="rec inline" aria-label="Record after eating note">Record</button>
  <div class="hint" style="text-align:center">Tap to record how it turned out</div></div>`;
  $('#rec').onclick=ev=>toggleRecord(ev.currentTarget,async blob=>{
    busy('Transcribing…');
    try{
      const transcript=await groq.transcribe(blob);
      if(!transcript)throw new Error('No speech was detected. Try recording again.');
      busy('Rating…');
      const r=await groq.extractRating(transcript);
      afterDraft={versionId:v.id,rating:r.rating,notes:r.notes,transcript,audio:blob};
      route();
    }catch(e){await route(true);fail(e)}
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
    await db.saveAfter(a.versionId,{rating:+$('#rating').value,notes:$('#notes').value.trim(),transcript:a.transcript,audio:a.audio});
    afterDraft=null;route();
  };
}

function settings(){
  app.innerHTML=`<h1>Settings</h1>
  <label for="key">Groq API key</label>
  <input id="key" type="password" autocomplete="off" placeholder="gsk_..." value="${esc(groq.getKey())}">
  <p class="hint">Stored only in this browser (localStorage). Never sent anywhere except Groq.</p>
  <div class="row"><button class="btn" id="save-key">Save key</button></div><p id="saved" class="muted" role="status"></p>`;
  $('#save-key').onclick=()=>{groq.setKey($('#key').value.trim());clearError();$('#saved').textContent='Saved.'};
}

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
