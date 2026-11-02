const KEY='cj_pantry';
const STAPLES=new Set(['water','salt']); // assumed always available
export const load=()=>{try{const a=JSON.parse(localStorage.getItem(KEY));return Array.isArray(a)?a:[]}catch{return []}};
const save=a=>localStorage.setItem(KEY,JSON.stringify(a));
export const norm=s=>String(s||'').toLowerCase().replace(/[^a-z0-9؀-ۿ ]+/g,' ').replace(/\s+/g,' ').trim();
const stem=w=>w.length>3&&w.endsWith('ies')?w.slice(0,-3)+'y':w.length>3&&w.endsWith('es')&&/(o|ch|sh|x)es$/.test(w)?w.slice(0,-2):w.length>3&&w.endsWith('s')&&!w.endsWith('ss')?w.slice(0,-1):w;
const words=s=>norm(s).split(' ').filter(Boolean).map(stem);
const UKEY='cj_pantry_unsure';
const loadUnsure=()=>{try{const a=JSON.parse(localStorage.getItem(UKEY));return Array.isArray(a)?a:[]}catch{return []}};
export const isUnsure=name=>loadUnsure().includes(name);
/** The cook confirmed a flagged item. */
export const confirm=name=>localStorage.setItem(UKEY,JSON.stringify(loadUnsure().filter(x=>x!==name)));
/** Add items: strings or {name,unsure}. An item already covered by one in the pantry (onion/onions/red onion) is merged, not duplicated.
 *  Returns the names actually added. */
export function add(items){
  const list=load(),added=[],unsure=loadUnsure();
  for(const it of items){
    const t=String(typeof it==='object'&&it?it.name:it||'').trim().replace(/\s+/g,' ');
    if(!t||list.some(x=>norm(x)===norm(t)||covers(x,t)))continue;
    list.push(t);added.push(t);
    if(it&&it.unsure)unsure.push(t);
  }
  save(list);localStorage.setItem(UKEY,JSON.stringify(unsure));return added;
}
export const remove=name=>{save(load().filter(x=>x!==name));confirm(name)};
/** Does pantry item p cover ingredient i? Equal, or one's words are all inside the other's ("red onion" ~ "onion"). */
export function covers(p,i){
  const a=words(p),b=words(i);
  if(!a.length||!b.length)return false;
  return a.every(w=>b.includes(w))||b.every(w=>a.includes(w));
}
export const isStaple=i=>STAPLES.has(norm(i));
export function missing(ingredientNames,pantry=load()){
  return ingredientNames.filter(i=>i&&!isStaple(i)&&!pantry.some(p=>covers(p,i)));
}
/** Best version of a dish: highest rating, ties -> newest. Unrated versions rank below rated. */
export function bestVersion(versions){
  return versions.slice().sort((a,b)=>(b.after?.rating||0)-(a.after?.rating||0)||b.n-a.n)[0];
}
/** Saved dishes that fit: [{dish,version,missing}] sorted by fewest missing, then rating. maxMissing default 2. */
export function fits(dishes,pantry=load(),maxMissing=2){
  return dishes.map(({dish,versions})=>{
    const version=bestVersion(versions);
    if(!version)return null;
    const names=version.ingredients.map(i=>i.name);
    if(!names.length)return null;
    return {dish,version,missing:missing(names,pantry)};
  }).filter(x=>x&&x.missing.length<=maxMissing)
    .sort((a,b)=>a.missing.length-b.missing.length||(b.version.after?.rating||0)-(a.version.after?.rating||0));
}
