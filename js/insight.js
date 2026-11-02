import {bestVersion,covers,isStaple} from './pantry.js';
import {diffIngredients} from './amounts.js';

/** F1: the best-rated version, if it beat the one before it. Returns {best,prev,diff,key} or null. */
export function whyBetter(versions){
  const best=bestVersion(versions);
  if(!best||!best.after||best.n<2)return null;
  const prev=versions.find(v=>v.n===best.n-1);
  if(!prev||(prev.after&&prev.after.rating>=best.after.rating))return null;
  return {best,prev,diff:diffIngredients(prev.ingredients,best.ingredients),key:`${prev.id}:${best.id}:${best.after.rating}:${prev.after?.rating??0}`};
}
/** F4: the newest after-eating note that says something. {n,rating,notes} or null. */
export function lastNote(versions){
  const v=versions.slice().sort((a,b)=>b.n-a.n).find(x=>x.after&&String(x.after.notes||'').trim());
  return v?{n:v.n,rating:v.after.rating,notes:v.after.notes.trim()}:null;
}
/** F3: pantry items used by these ingredients (staples like water/salt are left alone). */
export const usedFromPantry=(ingredients,pantry)=>pantry.filter(p=>!isStaple(p)&&ingredients.some(i=>i.name&&!isStaple(i.name)&&covers(p,i.name)));
