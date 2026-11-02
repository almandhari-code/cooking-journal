const BASE='https://api.groq.com/openai/v1';
export const MODELS=['openai/gpt-oss-120b','qwen/qwen3.8-27b'];
export const getKey=()=>localStorage.getItem('groq_api_key')||'';
export const setKey=k=>k?localStorage.setItem('groq_api_key',k):localStorage.removeItem('groq_api_key');

async function call(path,opts){
  const key=getKey();
  if(!key)throw new Error('NO_KEY');
  let r;
  try{r=await fetch(BASE+path,{...opts,headers:{Authorization:'Bearer '+key,...opts.headers}})}
  catch{throw new Error('Network error: could not reach Groq. Check your connection and try again.')}
  if(!r.ok){
    let m='';try{m=(await r.json()).error?.message||''}catch{}
    if(r.status===401)throw new Error('Groq rejected the API key (401). Check it in Settings.');
    if(r.status===429)throw new Error('Groq rate limit reached (429). Wait a moment and try again.');
    const e=new Error(`Groq API error (${r.status})${m?': '+m:''}`);e.status=r.status;throw e;
  }
  return r.json();
}

export const OMANI_VOCAB=['machboos','bzar','shuwa','harees','mashuai','laban','qahwa','halwa','kahwa','maqboos','saloona','mashkak','khubz','dates','cardamom','saffron','loomi'];
export const WHISPER_PROMPT='Omani home cooking. Food words: '+OMANI_VOCAB.join(', ')+'.';
export const MAX_BYTES=25*1024*1024;

export async function transcribe(blob,prev=''){
  if(blob.size>=MAX_BYTES)throw new Error('An audio chunk is over Groq\'s 25 MB limit. Try a shorter recording.');
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
      if(e.message==='NO_KEY'||e.message.startsWith('Network')||e.status===401)throw e;
      last=e;
    }
  }
  throw new Error('Could not understand the model response. '+(last?.message||''));
}

export const RECIPE_PROMPT=`You turn a spoken transcript of someone cooking (often Omani or Gulf home cooking) into a recipe. The transcript can be long and messy.
IGNORE chatter, small talk, jokes, interruptions, repeated or nonsense words, and silence artifacts such as "thank you" or "you". Keep ONLY cooking information: dish name, ingredients, amounts, steps, times, temperatures. Never invent ingredients or steps.
Normalize Omani/Arabic food spellings to these standard forms: ${OMANI_VOCAB.join(', ')}. For example makbous/machbous/makboos -> machboos, bazaar/bizar/bezar -> bzar, kahwa/gahwa -> qahwa, lomi/limu omani -> loomi.
Reply with JSON only: {"dish":string,"ingredients":[{"name":string,"amount":string,"unit":string}],"steps":[string]}. Use empty strings when the dish name, amount or unit are unknown. If there is no cooking content, return empty lists.`;
export async function extractRecipe(transcript){
  const o=await chatJSON(RECIPE_PROMPT,transcript);
  return {
    dish:String(o.dish||''),
    ingredients:(Array.isArray(o.ingredients)?o.ingredients:[]).map(i=>({name:String(i.name??''),amount:String(i.amount??''),unit:String(i.unit??'')})),
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
