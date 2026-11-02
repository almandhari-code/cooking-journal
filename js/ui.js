export const $=(s,r=document)=>r.querySelector(s);
export const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function showError(html){const e=$('#error');e.innerHTML=html;e.hidden=false}
export function clearError(){$('#error').hidden=true}
export const keyMissingMsg='Add your AI key first. <a href="#/settings">Open Settings</a>';
export const stars=n=>'★'.repeat(n)+'☆'.repeat(5-n);
export const fmtTime=s=>`${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;

/** Cute recipe card as a canvas (1080x1350): name, Arabic name, ingredients with amounts, short steps, rating. `amounts` gives say(). */
export function drawCard(dish,v,amounts){
  const W=1080,H=1350,c=document.createElement('canvas');c.width=W;c.height=H;
  const x=c.getContext('2d'),INK='#4a2342',PINK='#ff8fb8',ACC='#d93b79',FONT='ui-rounded,"SF Pro Rounded",Nunito,"Trebuchet MS",system-ui,sans-serif';
  x.fillStyle='#fff6e8';x.fillRect(0,0,W,H);
  x.fillStyle='#ffd9e8';for(let i=0;i<W;i+=48)for(let j=0;j<H;j+=48){x.beginPath();x.arc(i+12,j+12,3,0,7);x.fill()}
  x.fillStyle='#fffdf8';x.strokeStyle=INK;x.lineWidth=8;x.beginPath();x.roundRect(50,50,W-100,H-100,44);x.fill();x.stroke();
  x.fillStyle=PINK;x.beginPath();x.roundRect(50,50,W-100,230,[44,44,0,0]);x.fill();x.stroke();
  x.fillStyle=INK;x.textAlign='center';x.direction='ltr';
  const fit=(t,max,px)=>{let s=px;do{x.font=`800 ${s}px ${FONT}`;s-=2}while(x.measureText(t).width>max&&s>24);return t};
  x.fillText(fit(dish.name,W-200,76),W/2,dish.arabic?140:170);
  if(dish.arabic){x.direction='rtl';x.font=`700 54px ${FONT}`;x.fillText(dish.arabic,W/2,226);x.direction='ltr'}
  x.textAlign='left';
  let y=350;
  x.fillStyle=ACC;x.font=`800 44px ${FONT}`;x.fillText('🧺 Ingredients',100,y);y+=20;
  x.fillStyle=INK;x.font=`600 34px ${FONT}`;
  const ings=(v.ingredients||[]).slice(0,10);
  for(const i of ings){y+=48;x.fillText('• '+fitText(x,[amounts.say(i),i.name].filter(Boolean).join(' '),W-240),110,y)}
  if((v.ingredients||[]).length>10){y+=48;x.fillText(`…and ${v.ingredients.length-10} more`,110,y)}
  y+=74;x.fillStyle=ACC;x.font=`800 44px ${FONT}`;x.fillText('👩‍🍳 Steps',100,y);y+=20;
  x.fillStyle=INK;x.font=`600 32px ${FONT}`;
  const steps=(v.steps||[]).slice(0,4);
  steps.forEach((t,n)=>{y+=46;x.fillText(fitText(x,`${n+1}. ${t}`,W-240),110,y)});
  if((v.steps||[]).length>4){y+=46;x.fillText(`…and ${v.steps.length-4} more steps`,110,y)}
  x.textAlign='center';
  x.fillStyle='#e8860c';x.font=`800 64px ${FONT}`;
  x.fillText(v.after?stars(v.after.rating):'Not rated yet',W/2,H-150);
  x.fillStyle=INK;x.font=`700 30px ${FONT}`;x.fillText(`Cooking Journal · v${v.n}`,W/2,H-95);
  return c;
}
function fitText(x,t,max){
  t=String(t);if(x.measureText(t).width<=max)return t;
  while(t.length>1&&x.measureText(t+'…').width>max)t=t.slice(0,-1);
  return t.trimEnd()+'…';
}
