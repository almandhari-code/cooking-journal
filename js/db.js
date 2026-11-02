const DB='cooking-journal';
let dbp;
function open(){
  return dbp??=new Promise((res,rej)=>{
    const r=indexedDB.open(DB,2);
    r.onupgradeneeded=()=>{
      const d=r.result,has=n=>d.objectStoreNames.contains(n);
      if(!has('dishes'))d.createObjectStore('dishes',{keyPath:'id',autoIncrement:true}).createIndex('key','key',{unique:true});
      if(!has('versions'))d.createObjectStore('versions',{keyPath:'id',autoIncrement:true}).createIndex('dishId','dishId');
      if(!has('pending'))d.createObjectStore('pending',{keyPath:'id',autoIncrement:true});
    };
    r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);
  });
}
const wrap=r=>new Promise((res,rej)=>{r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
async function store(n,mode='readonly'){return (await open()).transaction(n,mode).objectStore(n)}

export async function listDishes(){
  const dishes=await wrap((await store('dishes')).getAll());
  const out=[];
  for(const d of dishes){
    const vs=await listVersions(d.id);
    out.push({...d,versionCount:vs.length,last:vs.at(-1)?.createdAt||0,status:vs.some(v=>v.after)?'finished':'planning'});
  }
  return out.sort((a,b)=>b.last-a.last);
}
export async function listVersions(dishId){
  const vs=await wrap((await store('versions')).index('dishId').getAll(dishId));
  return vs.sort((a,b)=>a.n-b.n);
}
export const getDish=async id=>wrap((await store('dishes')).get(id));
export const getVersion=async id=>wrap((await store('versions')).get(id));

/** Save a new version; creates the dish if the (case-insensitive) name is new. */
export async function saveVersion({name,ingredients,steps,transcript,parts}){
  name=name.trim();
  const key=name.toLowerCase();
  let dish=await wrap((await store('dishes')).index('key').get(key));
  const newDish=!dish;
  if(!dish){
    const id=await wrap((await store('dishes','readwrite')).add({name,key}));
    dish={id,name,key};
  }
  const n=(await listVersions(dish.id)).length+1;
  const v={dishId:dish.id,n,createdAt:Date.now(),ingredients,steps,transcript,audio:parts[0],parts,after:null};
  v.id=await wrap((await store('versions','readwrite')).add(v));
  return {...v,newDish};
}
export async function saveAfter(versionId,after){
  const v=await getVersion(versionId);
  v.after={...after,at:Date.now()};
  await wrap((await store('versions','readwrite')).put(v));
  return v;
}
/** Merge extra recipe info into a base: new ingredient names and steps are added, nothing is overwritten. */
export function mergeRecipe(base,add){
  const ingredients=base.ingredients.map(i=>({...i}));
  for(const i of add.ingredients||[]){
    const have=ingredients.find(x=>x.name.trim().toLowerCase()===i.name.trim().toLowerCase());
    if(!have)ingredients.push({...i});
    else if(!have.amount&&i.amount){have.amount=i.amount;have.unit=i.unit}
  }
  const seen=new Set(base.steps.map(s=>s.trim().toLowerCase()));
  const steps=[...base.steps];
  for(const s of add.steps||[])if(!seen.has(s.trim().toLowerCase())){seen.add(s.trim().toLowerCase());steps.push(s)}
  return {ingredients,steps};
}
/** "Add to this dish": append a later recording to a saved version. */
export async function appendToVersion(id,{parts,transcript,recipe}){
  const v=await getVersion(id);
  Object.assign(v,mergeRecipe(v,recipe));
  v.parts=[...(v.parts||[v.audio]).filter(Boolean),...parts];
  v.transcript=[v.transcript,transcript].filter(Boolean).join('\n\n');
  v.appends=(v.appends||0)+1;
  await wrap((await store('versions','readwrite')).put(v));
  return v;
}

/* ---------- pending sessions: audio is saved here the moment it exists, removed only after the result is saved ---------- */
/** kind: 'new' | 'append' | 'after' | 'pantry'. status: 'recording' | 'new' | 'queued' | 'error' */
export async function createPending(o){
  const p={kind:'new',targetId:null,intoDraft:false,parts:[],live:null,texts:[],status:'recording',error:'',createdAt:Date.now(),...o};
  p.id=await wrap((await store('pending','readwrite')).add(p));
  return p;
}
export const getPending=async id=>wrap((await store('pending')).get(id));
export const listPending=async()=>(await wrap((await store('pending')).getAll())).sort((a,b)=>a.createdAt-b.createdAt);
/** Merge fields into a pending record (read-modify-write in one transaction). */
export async function patchPending(id,fields){
  const t=(await open()).transaction('pending','readwrite'),st=t.objectStore('pending');
  const p=await wrap(st.get(id));
  if(!p)return null;
  Object.assign(p,fields);
  await wrap(st.put(p));
  return p;
}
export async function deletePending(id){await wrap((await store('pending','readwrite')).delete(id))}

/* ---------- backup support ---------- */
const STORES=['dishes','versions','pending'];
export async function dumpAll(){
  const out={};
  for(const n of STORES)out[n]=await wrap((await store(n)).getAll());
  return out;
}
/** Replace everything in IndexedDB with the given rows (ids are kept so links between dishes and versions survive). */
export async function restoreAll(rows){
  const t=(await open()).transaction(STORES,'readwrite');
  const done=new Promise((res,rej)=>{t.oncomplete=res;t.onerror=()=>rej(t.error);t.onabort=()=>rej(t.error)});
  for(const n of STORES){const st=t.objectStore(n);st.clear();for(const r of rows[n]||[])st.put(r)}
  await done;
}

/** Privacy: remove all audio from a version (and its after-eating note), keep recipe, transcript and rating. */
export async function deleteAudio(id){
  const v=await getVersion(id);
  v.audio=null;v.parts=[];v.audioDeleted=true;
  if(v.after){v.after.audio=null;v.after.parts=[]}
  await wrap((await store('versions','readwrite')).put(v));
}
