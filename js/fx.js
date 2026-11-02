import * as sound from './sound.js';
import {esc} from './ui.js';

/** Toast + confetti + sounds for an award() result. */
export function celebrate(res){
  const box=document.getElementById('toast');
  const lines=[`<b>+${res.gained} XP</b>${res.streakBonus?` <span>🔥 streak ${res.streak}</span>`:''}`];
  if(res.leveled)lines.push(`<b>🎉 Level ${res.level}!</b>`);
  for(const b of res.newBadges)lines.push(`<span>${b.emoji} New badge: <b>${esc(b.name)}</b></span>`);
  const el=document.createElement('div');
  el.className='toast';el.innerHTML=lines.join('<br>');
  box.replaceChildren(el);
  sound.play(res.leveled?'level':res.newBadges.length?'badge':'success');
  confetti(res.leveled||res.newBadges.length?22:10);
  setTimeout(()=>el.remove(),3800);
}
function confetti(n){
  const f=['🌸','✨','🎀','💖','⭐','🧁'];
  for(let i=0;i<n;i++){
    const s=document.createElement('span');
    s.className='confetti';s.textContent=f[i%f.length];
    s.style.cssText=`left:${10+Math.random()*80}%;--dx:${Math.round(Math.random()*120-60)}px;animation-delay:${Math.random()*.25}s`;
    document.body.append(s);setTimeout(()=>s.remove(),1900);
  }
}
