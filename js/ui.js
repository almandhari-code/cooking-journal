export const $=(s,r=document)=>r.querySelector(s);
export const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function showError(html){const e=$('#error');e.innerHTML=html;e.hidden=false}
export function clearError(){$('#error').hidden=true}
export const keyMissingMsg='Add your Groq API key first. <a href="#/settings">Open Settings</a>';
export const stars=n=>'★'.repeat(n)+'☆'.repeat(5-n);
export const fmtTime=s=>`${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
