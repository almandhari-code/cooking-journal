import {enrichAll} from './amounts.js';
const BASE='https://api.groq.com/openai/v1';
export const MODELS=['openai/gpt-oss-120b','qwen/qwen3.8-27b'];
export const getKey=()=>localStorage.getItem('groq_api_key')||'';
export const setKey=k=>k?localStorage.setItem('groq_api_key',k):localStorage.removeItem('groq_api_key');

let statusFn=()=>{};
/** The UI registers here to show "Groq is busy, retrying in 5s…" (empty string clears it). */
export const onStatus=f=>{statusFn=f||(()=>{})};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
/** Seconds to wait after a 429: the retry-after header (seconds or a date) if present, else 2,4,8,16… capped at 60. */
export function backoffSeconds(headers,attempt){
  const ra=headers?.get?.('retry-after');
  let s=ra==null||ra===''?NaN:Number(ra);
  if(Number.isNaN(s)&&ra)s=(Date.parse(ra)-Date.now())/1000;
  if(Number.isNaN(s))s=2**attempt;
  return Math.min(60,Math.max(1,Math.ceil(s)));
}

async function call(path,opts){
  const key=getKey();
  if(!key)throw new Error('NO_KEY');
  const max=+window.CJ_MAX_TRIES||5;
  for(let attempt=1;;attempt++){
    let r;
    try{r=await fetch(BASE+path,{...opts,headers:{Authorization:'Bearer '+key,...opts.headers}})}
    catch{statusFn('');throw Object.assign(new Error('Network error: could not reach the AI service. Check your connection and try again.'),{network:true})}
    if(r.status===429&&attempt<max){ // rate limited: wait as told and try again, no taps needed
      for(let left=backoffSeconds(r.headers,attempt);left>0;left--){
        statusFn(`The AI service is busy (rate limit). Trying again in ${left}s… (attempt ${attempt+1} of ${max})`);
        await sleep(1000);
      }
      statusFn('');continue;
    }
    statusFn('');
    if(!r.ok){
      let m='';try{m=(await r.json()).error?.message||''}catch{}
      if(r.status===401)throw Object.assign(new Error('The AI service rejected the AI key (401). Check it in Settings.'),{status:401});
      if(r.status===429)throw Object.assign(new Error('AI service rate limit reached (429). It is still busy after several tries.'),{status:429});
      const e=new Error(`AI service error (${r.status})${m?': '+m:''}`);e.status=r.status;throw e;
    }
    return r.json();
  }
}

export const OMANI_VOCAB=['machboos','bzar','shuwa','harees','mashuai','laban','qahwa','halwa','kahwa','maqboos','saloona','mashkak','khubz','dates','cardamom','saffron','loomi'];
export const WHISPER_PROMPT='Omani home cooking. Food words: '+OMANI_VOCAB.join(', ')+'.';
export const MAX_BYTES=25*1024*1024;

export async function transcribe(blob,prev=''){
  if(blob.size>=MAX_BYTES)throw new Error('An audio chunk is over the AI service\'s 25 MB limit. Try a shorter recording.');
  const ext=blob.type.includes('mp4')?'mp4':'webm';
  const f=new FormData();
  f.append('file',blob,`audio.${ext}`);
  f.append('model','whisper-large-v3-turbo');
  f.append('language','en');
  // vocab first, tail of previous chunk last (Whisper only reads the end of long prompts)
  f.append('prompt',WHISPER_PROMPT+(prev?' '+prev.slice(-150):''));
  const j=await call('/audio/transcriptions',{method:'POST',body:f});
  return (j.text||'').trim();
}
/** Transcribe chunks in order and merge. onPart(i,n) is called before each chunk. */
export async function transcribeParts(parts,onPart){
  let out=[];
  for(let i=0;i<parts.length;i++){
    onPart?.(i+1,parts.length);
    const t=await transcribe(parts[i],out.join(' '));
    if(t)out.push(t);
  }
  return out.join(' ');
}

async function chatJSON(system,user){
  let last;
  for(const model of MODELS){
    try{
      const j=await call('/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({model,response_format:{type:'json_object'},messages:[{role:'system',content:system},{role:'user',content:user}]})});
      const txt=j.choices?.[0]?.message?.content||'';
      return JSON.parse(txt.replace(/^```(?:json)?|```$/g,'').trim());
    }catch(e){
      if(e.message==='NO_KEY'||e.network||e.status===401||e.status===429)throw e;
      last=e;
    }
  }
  throw new Error('Could not understand the model response. '+(last?.message||''));
}

export const RECIPE_PROMPT=`You turn a spoken transcript of someone cooking (often Omani or Gulf home cooking) into a recipe. The transcript can be long and messy.
IGNORE chatter, small talk, jokes, interruptions, repeated or nonsense words, and silence artifacts such as "thank you" or "you". Keep ONLY cooking information: dish name, ingredients, amounts, steps, times, temperatures. Never invent ingredients or steps.
Normalize Omani/Arabic food spellings to these standard forms: ${OMANI_VOCAB.join(', ')}. For example makbous/machbous/makboos -> machboos, bazaar/bizar/bezar -> bzar, kahwa/gahwa -> qahwa, lomi/limu omani -> loomi.
Reply with JSON only: {"dish":string,"ingredients":[{"name":string,"amount":string,"unit":string,"qty_num":number|null,"unit_std":"g"|"ml"|"","approx":boolean}],"steps":[string]}. amount/unit keep the cook's own words ("a handful", "2 cups"). qty_num is the amount in unit_std (g or ml; a handful ~ 30 g, a pinch ~ 0.4 g, a spoon ~ 12 g, a cup = 240 ml) and approx is true when the amount is vague or a rough unit. Use empty strings when the dish name, amount or unit are unknown, null qty_num when unknown. If there is no cooking content, return empty lists.`;
export async function extractRecipe(transcript){
  const o=await chatJSON(RECIPE_PROMPT,transcript);
  return {
    dish:String(o.dish||''),
    ingredients:enrichAll((Array.isArray(o.ingredients)?o.ingredients:[]).map(i=>({name:String(i.name??''),amount:String(i.amount??''),unit:String(i.unit??'')}))), // numbers always derived locally so they are consistent
    steps:(Array.isArray(o.steps)?o.steps:[]).map(String)
  };
}
export async function extractRating(transcript){
  const o=await chatJSON(
    'The cook describes how a dish turned out after eating it. Reply with JSON only: {"rating":integer 1-5,"notes":string}. Notes summarise what to remember or change next time.',
    transcript);
  const rating=Math.min(5,Math.max(1,Math.round(Number(o.rating))||3));
  return {rating,notes:String(o.notes||'')};
}

export const PANTRY_PROMPT='The cook lists food items they have at home (spoken, may include chatter). Reply with JSON only: {"items":[{"name":string,"unsure":boolean}]}. One short ingredient name per item, lowercase, no amounts. Ignore chatter and nonsense. Normalize Omani/Arabic spellings to: '+OMANI_VOCAB.join(', ')+'. Set unsure to true when the word may have been misheard or you are not sure it is a food; otherwise false. Always return every food item mentioned.';
/** Last-resort parse when the model returns nothing usable: split the transcript on commas / "and". Items are flagged unsure. */
export function localPantryItems(transcript){
  return String(transcript||'').toLowerCase().split(/[,،;.\n]+|\band\b|&/)
    .map(x=>x.replace(/\b(i|we)\s+(have|got)\b|\bthere\s+(is|are)\b|\b(some|also|then|plus|a|an|the|um|uh)\b/g,' ').replace(/[^\p{L}\p{N} -]+/gu,' ').replace(/\s+/g,' ').trim())
    .filter(x=>x&&x.split(' ').length<=3).map(name=>({name,unsure:true}));
}
/** Accepts {"items":[...]} or any other array-of-things the model sends back; strings, {name}, {item}, {ingredient}. */
export function parsePantry(o){
  let arr=Array.isArray(o)?o:Array.isArray(o?.items)?o.items:Object.values(o||{}).find(Array.isArray)||(typeof o?.items==='string'?o.items.split(','):[]);
  return arr.map(x=>typeof x==='object'&&x?{name:String(x.name??x.item??x.ingredient??'').trim(),unsure:!!x.unsure}:{name:String(x).trim(),unsure:false})
    .filter(x=>x.name&&x.name!=='[object Object]');
}
export async function extractPantry(transcript){
  let items=[];
  try{items=parsePantry(await chatJSON(PANTRY_PROMPT,transcript))}
  catch(e){if(e.message==='NO_KEY'||e.network||e.status)throw e} // unparseable reply: fall through to the local split
  return items.length?items:localPantryItems(transcript);
}
export const IDEAS_PROMPT='You suggest dishes someone can cook from what is in their pantry (Omani and Gulf home cooking is welcome, but any cuisine is fine). Water, salt and basic oil are always available. Suggest 4 realistic dishes that use mostly pantry items, each needing at most 3 extra ingredients. Do not suggest dishes from the "already known" list. Reply with JSON only: {"ideas":[{"name":string,"why":string (one short sentence),"missing":[string]}]}.';
export async function suggestIdeas(pantry,known=[]){
  const o=await chatJSON(IDEAS_PROMPT,JSON.stringify({pantry,alreadyKnown:known}));
  return (Array.isArray(o.ideas)?o.ideas:[]).map(i=>({name:String(i.name||''),why:String(i.why||''),missing:(Array.isArray(i.missing)?i.missing:[]).map(String)})).filter(i=>i.name);
}
