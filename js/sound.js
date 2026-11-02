const KEY='cj_settings';
const read=()=>{try{return JSON.parse(localStorage.getItem(KEY))||{}}catch{return {}}};
export const isMuted=()=>!!read().mute;
export const setMuted=m=>localStorage.setItem(KEY,JSON.stringify({...read(),mute:!!m}));

// [frequency Hz, seconds] sequences
const SONGS={
  tap:[[660,.06]],start:[[523,.08],[784,.12]],stop:[[784,.08],[523,.12]],
  pause:[[440,.08],[330,.1]],resume:[[330,.08],[440,.1]],
  success:[[523,.09],[659,.09],[784,.09],[1047,.2]],
  level:[[392,.1],[523,.1],[659,.1],[784,.1],[1047,.1],[1319,.3]],
  badge:[[880,.08],[1109,.08],[1319,.25]],error:[[220,.15],[165,.2]]
};
let ctx;
export function play(name){
  if(isMuted()||!SONGS[name])return;
  (window.__cjSounds??=[]).push(name); // lets tests see what played
  try{
    ctx??=new (window.AudioContext||window.webkitAudioContext)();
    ctx.resume?.();
    let t=ctx.currentTime;
    for(const [f,d] of SONGS[name]){
      const o=ctx.createOscillator(),g=ctx.createGain();
      o.type='triangle';o.frequency.value=f;
      g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(.18,t+.01);g.gain.exponentialRampToValueAtTime(.0001,t+d);
      o.connect(g).connect(ctx.destination);o.start(t);o.stop(t+d+.02);t+=d*.9;
    }
  }catch{}
}
