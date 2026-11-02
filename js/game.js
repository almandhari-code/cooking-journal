const KEY='cj_game';
const dayStr=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const dayNum=s=>{const[y,m,d]=s.split('-').map(Number);return Math.round(Date.UTC(y,m-1,d)/864e5)};
/** Whole calendar weeks (Monday start) between two day strings. */
const weekDiff=(a,b)=>Math.floor((dayNum(b)+3)/7)-Math.floor((dayNum(a)+3)/7);
export const XP_PER_LEVEL=100;
export const levelOf=xp=>1+Math.floor(xp/XP_PER_LEVEL);

export const BADGES=[
  {id:'first-dish',emoji:'🍳',name:'First Dish',desc:'Save your first recipe',test:g=>g.counts.dish>=1},
  {id:'tinkerer',emoji:'🧪',name:'Tinkerer',desc:'Reach version 3 of one dish',test:g=>g.counts.maxVersions>=3},
  {id:'taster',emoji:'😋',name:'Taste Tester',desc:'Rate a dish after eating',test:g=>g.counts.rate>=1},
  {id:'five-star',emoji:'⭐',name:'Five Stars',desc:'Give a dish 5 stars',test:g=>g.counts.five>=1},
  {id:'extra-spoon',emoji:'🥄',name:'Extra Spoon',desc:'Add to a dish mid-cook',test:g=>g.counts.append>=1},
  {id:'marathon',emoji:'🏃',name:'Marathon Cook',desc:'Record a long session with pauses',test:g=>g.counts.marathon>=1},
  {id:'streak3',emoji:'🔥',name:'On Fire',desc:'3-week streak',test:g=>g.streak>=3},
  {id:'streak7',emoji:'🏆',name:'Week Warrior',desc:'7-week streak',test:g=>g.streak>=7},
  {id:'level5',emoji:'👑',name:'Kitchen Royalty',desc:'Reach level 5',test:g=>levelOf(g.xp)>=5},
];

export function load(){
  let g={};try{g=JSON.parse(localStorage.getItem(KEY))||{}}catch{}
  const o={xp:0,streak:0,best:0,lastDay:'',badges:[],...g,
    counts:{dish:0,rate:0,five:0,append:0,marathon:0,maxVersions:0,...g.counts}};
  if(g.unit!=='week'){o.unit='week';o.streak=o.lastDay?Math.min(o.streak,1):0;o.best=Math.min(o.best,o.streak)} // old saves counted days: restart as weeks
  return o;
}
/** Weekly streak as shown today: it lapses if you skipped a whole calendar week. */
export function currentStreak(g=load(),now=new Date()){
  return g.lastDay&&weekDiff(g.lastDay,dayStr(now))<=1?g.streak:0;
}
/** kind: 'dish' | 'rate' | 'append'. Returns what changed so the UI can celebrate. */
export function award(kind,ctx={},now=new Date()){
  const g=load(),before=levelOf(g.xp),t=dayStr(now);
  let gained=0,streakBonus=0;
  const wd=g.lastDay?weekDiff(g.lastDay,t):null;
  if(wd!==0){ // first activity ever, or first one in a new calendar week
    g.streak=wd===1?g.streak+1:1;
    g.best=Math.max(g.best,g.streak);
    streakBonus=5*Math.min(g.streak,7);gained+=streakBonus;
  }
  g.lastDay=t;
  if(kind==='dish'){gained+=50+(ctx.newDish?25:0);g.counts.dish++;g.counts.maxVersions=Math.max(g.counts.maxVersions,ctx.n||0)}
  else if(kind==='rate'){gained+=30+(ctx.rating===5?10:0);g.counts.rate++;if(ctx.rating===5)g.counts.five++}
  else if(kind==='append'){gained+=20;g.counts.append++}
  if(ctx.long){gained+=15;g.counts.marathon++}
  g.xp+=gained;
  const newBadges=BADGES.filter(b=>!g.badges.includes(b.id)&&b.test(g));
  g.badges.push(...newBadges.map(b=>b.id));
  localStorage.setItem(KEY,JSON.stringify(g));
  const level=levelOf(g.xp);
  return {gained,streakBonus,streak:g.streak,xp:g.xp,level,leveled:level>before,newBadges};
}
