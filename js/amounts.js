/** Structured amounts: {qty_num, unit_std, approx} derived from the free-text amount/unit the cook said. */
const WORDS={a:1,an:1,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,half:.5,quarter:.25,couple:2,few:3,some:1};
// unit -> [standard unit, factor, approx?]. Handful/pinch/spoon are rough kitchen units turned into grams.
const UNITS={
  g:['g',1],gram:['g',1],kg:['g',1000],kilo:['g',1000],oz:['g',28.35],lb:['g',453.6],
  ml:['ml',1],l:['ml',1000],liter:['ml',1000],litre:['ml',1000],cup:['ml',240],tbsp:['ml',15],tablespoon:['ml',15],tsp:['ml',5],teaspoon:['ml',5],
  handful:['g',30,true],pinch:['g',.4,true],spoon:['g',12,true],spoonful:['g',12,true],dash:['g',.6,true],
};
const unitKey=u=>{u=String(u||'').toLowerCase().replace(/[^a-z]/g,'');return u in UNITS?u:u.endsWith('es')&&u.slice(0,-2) in UNITS?u.slice(0,-2):u.endsWith('s')&&u.slice(0,-1) in UNITS?u.slice(0,-1):u};
function qtyOf(text){
  const t=String(text||'').toLowerCase();
  const m=t.match(/(\d+)\s+(\d+)\/(\d+)|(\d+)\/(\d+)|\d+(?:\.\d+)?/);
  if(m){if(m[2])return +m[1]+m[2]/m[3];if(m[4])return m[4]/m[5];return +m[0]}
  for(const w of t.split(/[^a-z]+/))if(w in WORDS)return WORDS[w];
  return null;
}
/** Returns the ingredient with qty_num (number|null), unit_std ('g'|'ml'|'' or the raw unit) and approx (bool). */
export function enrich(i){
  const amount=String(i.amount??'').trim(),unit=String(i.unit??'').trim();
  // the unit may be only in the amount text ("a handful") or in the unit field ("cups")
  const words=(amount+' '+unit).toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const uk=[unitKey(unit),...words.map(unitKey)].find(k=>k in UNITS);
  let q=qtyOf(amount)??qtyOf(unit);
  const vague=/\b(some|few|couple|about|around|roughly|approx\w*|a bit|little)\b/i.test(amount+' '+unit);
  if(!uk){const num=!/\d/.test(amount+unit)&&/\b(some|few|little|bit)\b/i.test(amount+' '+unit)?null:q; // "some sprinkles" has no number: keep her words
    return {...i,qty_num:num,unit_std:unit.toLowerCase(),approx:vague||(num==null&&!!amount)}}
  const [std,f,rough]=UNITS[uk];
  if(q==null)q=1;
  return {...i,qty_num:Math.round(q*f*100)/100,unit_std:std,approx:!!rough||vague};
}
export const enrichAll=l=>(l||[]).map(enrich);
/** "≈30 g". Empty when there is no number or the unit is her own word ("sprinkles"): callers then show her words, see say(). */
export const fmtQty=i=>i.qty_num==null||(i.unit_std&&i.unit_std!=='g'&&i.unit_std!=='ml')?'':`${i.approx?'≈':''}${i.qty_num}${i.unit_std?' '+i.unit_std:''}`;

/** v1 vs v2: which ingredients were added, removed or changed. Names match loosely (onion ~ onions). */
const key=n=>String(n||'').toLowerCase().replace(/[^a-z0-9 ]+/g,' ').split(' ').filter(Boolean).map(w=>w.length>3&&w.endsWith('s')&&!w.endsWith('ss')?w.slice(0,-1):w).join(' ');
export function diffIngredients(oldList,newList){
  const o=enrichAll(oldList).map(i=>i.qty_num===undefined?i:i),n=enrichAll(newList);
  const added=[],changed=[],removed=[],used=new Set();
  for(const i of n){
    const j=o.findIndex((x,idx)=>!used.has(idx)&&key(x.name)===key(i.name));
    if(j<0){added.push(i);continue}
    used.add(j);const x=o[j];
    if(x.qty_num!==i.qty_num||x.unit_std!==i.unit_std)changed.push({name:i.name,from:x,to:i});
  }
  o.forEach((x,idx)=>{if(!used.has(idx))removed.push(x)});
  return {added,removed,changed};
}

/** How to show an amount: the converted figure if there is one, else exactly what she said ("some sprinkles"). */
export const say=i=>fmtQty(i)||[i.amount,i.unit].filter(Boolean).join(' ');
