import * as db from './db.js';
import * as zip from './zip.js';

/* ---- keep the browser from evicting our data ---- */
export const persist=async()=>{try{return !!await navigator.storage?.persist?.()}catch{return false}};
export const isPersisted=async()=>{try{return !!await navigator.storage?.persisted?.()}catch{return false}};

/* ---- home-screen install ---- */
let deferred=null;
addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferred=e;dispatchEvent(new Event('cj-install'))});
addEventListener('appinstalled',()=>{deferred=null;dispatchEvent(new Event('cj-install'))});
const standalone=()=>matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
const ios=()=>/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
/** null (nothing to show) | 'prompt' (browser can install) | 'ios' (needs manual Share > Add to Home Screen) */
export const installMode=()=>standalone()?null:deferred?'prompt':ios()?'ios':null;
export async function install(){if(!deferred)return;const d=deferred;deferred=null;await d.prompt();dispatchEvent(new Event('cj-install'))}

/* ---- backup: one zip with everything ---- */
const LS_PREFIX='cj_'; // game progress, pantry, sound settings. The API key is deliberately NOT exported.
const lsKeys=()=>Object.keys(localStorage).filter(k=>k.startsWith(LS_PREFIX));

async function encode(v,files,seen){
  if(v instanceof Blob){
    let n=seen.get(v);
    if(!n){n=`blobs/${files.length}`;seen.set(v,n);files.push([n,new Uint8Array(await v.arrayBuffer())])}
    return {$blob:n,type:v.type};
  }
  if(Array.isArray(v)){const o=[];for(const x of v)o.push(await encode(x,files,seen));return o}
  if(v&&typeof v==='object'){const o={};for(const k of Object.keys(v))o[k]=await encode(v[k],files,seen);return o}
  return v;
}
function decode(v,files,made){
  if(Array.isArray(v))return v.map(x=>decode(x,files,made));
  if(v&&typeof v==='object'){
    if('$blob'in v){
      if(!made.has(v.$blob)){const b=files.get(v.$blob);if(!b)throw new Error('The backup is missing audio: '+v.$blob);made.set(v.$blob,new Blob([b],{type:v.type}))}
      return made.get(v.$blob);
    }
    return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,decode(x,files,made)]));
  }
  return v;
}

export async function exportAll(){
  const files=[],seen=new Map();
  const data=await encode(await db.dumpAll(),files,seen);
  const ls={};for(const k of lsKeys())ls[k]=localStorage.getItem(k);
  const manifest={app:'cooking-journal',format:1,exportedAt:new Date().toISOString(),localStorage:ls,db:data};
  return zip.write([['backup.json',new TextEncoder().encode(JSON.stringify(manifest))],...files]);
}
async function parse(file){
  const files=zip.read(await file.arrayBuffer());
  const raw=files.get('backup.json');
  if(!raw)throw new Error('This zip is not a Cooking Journal backup.');
  const m=JSON.parse(new TextDecoder().decode(raw));
  if(m.app!=='cooking-journal'||m.format!==1)throw new Error('This zip is not a Cooking Journal backup.');
  return {m,files};
}
const counts=d=>({dishes:d.dishes?.length||0,sessions:d.versions?.length||0,pending:d.pending?.length||0});
/** Backup date and counts, next to what is on this device now. Throws on a bad file. */
export async function inspect(file){
  const {m}=await parse(file);
  return {exportedAt:m.exportedAt,backup:counts(m.db),current:counts(await db.dumpAll())};
}
/** Import a backup. Dishes/versions/progress are replaced; pending sessions are kept (backup ones are added). */
export async function importAll(file){
  const {m,files}=await parse(file);
  const rows=decode(m.db,files,new Map());           // decode everything first so a bad file changes nothing
  await db.restoreAll(rows);
  for(const k of lsKeys())localStorage.removeItem(k);
  for(const [k,v] of Object.entries(m.localStorage||{}))if(k.startsWith(LS_PREFIX))localStorage.setItem(k,v);
}
