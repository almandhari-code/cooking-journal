const DB='cooking-journal';
let dbp;
function open(){
  return dbp??=new Promise((res,rej)=>{
    const r=indexedDB.open(DB,1);
    r.onupgradeneeded=()=>{
      const d=r.result;
      d.createObjectStore('dishes',{keyPath:'id',autoIncrement:true}).createIndex('key','key',{unique:true});
      d.createObjectStore('versions',{keyPath:'id',autoIncrement:true}).createIndex('dishId','dishId');
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
    out.push({...d,versionCount:vs.length,last:vs.at(-1)?.createdAt||0});
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
export async function saveVersion({name,ingredients,steps,transcript,audio}){
  name=name.trim();
  const key=name.toLowerCase();
  let dish=await wrap((await store('dishes')).index('key').get(key));
  if(!dish){
    const id=await wrap((await store('dishes','readwrite')).add({name,key}));
    dish={id,name,key};
  }
  const n=(await listVersions(dish.id)).length+1;
  const v={dishId:dish.id,n,createdAt:Date.now(),ingredients,steps,transcript,audio,after:null};
  v.id=await wrap((await store('versions','readwrite')).add(v));
  return v;
}
export async function saveAfter(versionId,after){
  const v=await getVersion(versionId);
  v.after={...after,at:Date.now()};
  await wrap((await store('versions','readwrite')).put(v));
  return v;
}
