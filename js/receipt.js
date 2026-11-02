import {readReceipt} from './groq.js';
import {enrich} from './amounts.js';
import {covers,norm} from './pantry.js';

const PDF_URL=new URL('../vendor/pdfjs/pdf.min.mjs',import.meta.url).href;
const WORKER_URL=new URL('../vendor/pdfjs/pdf.worker.min.mjs',import.meta.url).href;
export const MAX_IMG_BYTES=4*1024*1024;
export const MAX_FILE_BYTES=25*1024*1024;
const MAX_PAGES=3,MIN_TEXT=15; // fewer text characters than this = scanned PDF, no text layer

let pdfjs;
async function lib(){
  if(!pdfjs){pdfjs=await import(PDF_URL);pdfjs.GlobalWorkerOptions.workerSrc=WORKER_URL}
  return pdfjs;
}
/** Group text items into lines by their vertical position. */
function pageLines(items){
  const rows=[];
  for(const it of items){
    if(!it.str||!it.str.trim())continue;
    const y=Math.round(it.transform[5]),x=it.transform[4];
    let r=rows.find(r=>Math.abs(r.y-y)<=3);
    if(!r)rows.push(r={y,parts:[]});
    r.parts.push({x,s:it.str});
  }
  return rows.sort((a,b)=>b.y-a.y).map(r=>r.parts.sort((a,b)=>a.x-b.x).map(p=>p.s).join(' ').replace(/\s+/g,' ').trim()).filter(Boolean);
}
/** Read a PDF in the browser. Returns {lines:[…]} when it has text, or {lines:[],images:[dataUrl…]} for a scanned PDF (pages rendered to pictures). */
export async function readPdf(file){
  const {getDocument}=await lib();
  const pdf=await getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;
  const lines=[];
  try{
    for(let i=1;i<=pdf.numPages;i++){
      const page=await pdf.getPage(i);
      lines.push(...pageLines((await page.getTextContent()).items));
    }
    if(lines.join('').length>=MIN_TEXT)return {lines,pages:pdf.numPages};
    const images=[];
    for(let i=1;i<=Math.min(pdf.numPages,MAX_PAGES);i++){
      const page=await pdf.getPage(i),vp0=page.getViewport({scale:1}),scale=Math.min(2,1600/Math.max(vp0.width,vp0.height));
      const vp=page.getViewport({scale}),c=document.createElement('canvas');
      c.width=Math.ceil(vp.width);c.height=Math.ceil(vp.height);
      const g=c.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,c.width,c.height);
      await page.render({canvasContext:g,viewport:vp}).promise;
      images.push(await shrink(c));
    }
    return {lines:[],images,pages:pdf.numPages};
  }finally{pdf.destroy?.()}
}
/** Draw onto a fresh canvas (drops EXIF/location), downscale and lower quality until the JPEG is under 4 MB. Returns a data URL. */
async function shrink(src){
  let w=src.width,h=src.height,max=1600,q=.85,url;
  for(let n=0;n<8;n++){
    const k=Math.min(1,max/Math.max(w,h)),c=document.createElement('canvas');
    c.width=Math.max(32,Math.round(w*k));c.height=Math.max(32,Math.round(h*k)); // the vision model needs >=32px per side
    c.getContext('2d').drawImage(src,0,0,c.width,c.height);
    url=c.toDataURL('image/jpeg',q);
    if(url.length*.75<MAX_IMG_BYTES*.9)return url; // base64 is 4/3 the size of the bytes
    max=Math.round(max*.75);q=Math.max(.5,q-.1);
  }
  if(url.length*.75>=MAX_IMG_BYTES)throw new Error('This picture is too large to send even after shrinking it. Try a smaller photo, or type the items.');
  return url;
}
/** Re-encode a photo through a canvas: EXIF and GPS data do not survive. */
export async function readPhoto(file){
  let bmp;
  try{bmp=await createImageBitmap(file,{imageOrientation:'from-image'})}
  catch{throw new Error('Could not open this picture. Try a JPG or PNG photo.')}
  const url=await shrink(bmp);bmp.close?.();
  return {images:[url]};
}

/** Words that mark a line as not-food, even if the AI let it through. */
const NOT_FOOD=new RegExp('^\\s*(?:'+[
  '(?:(?:carrier|plastic|paper|shopping|reusable)\\s+)?bags?(?:\\s+\\S+)?', // bag lines
  '(?:vat|tax|gst)\\b.*','(?:sub\\s*)?total\\b.*','grand\\s+total\\b.*','amount\\s+(?:due|paid)\\b.*',
  'change(?:\\s+due)?','cash(?:\\s+\\S+)?','card(?:\\s+(?:payment|payments))?','(?:visa|mastercard)\\b.*',
  'discounts?\\b.*','service\\s+(?:charge|fee)\\b.*','delivery(?:\\s+(?:fee|charge))?','(?:tip|rounding|balance|receipt|invoice)\\b.*',
  '(?:loyalty\\s+)?points\\b.*','(?:voucher|coupon)\\b.*',
  '(?:order|receipt|invoice|ref|tel|phone)\\s*(?:no\\.?|number|#|:).*','(?:tel|phone)\\b.*',
  '(?:store|shop|branch)\\s*(?:no\\.?|number|#|:|name|address).*','(?:thank\\s+you).*'
].join('|')+')\\s*[:.]?\\s*$','i');
/** Turn the AI reply into checklist rows: food only, deduped, quantities normalized, unsure ones flagged. */
export function parseReceipt(o,have=[]){
  const arr=Array.isArray(o)?o:Array.isArray(o?.items)?o.items:[];
  const out=[];
  for(const x of arr){
    const obj=x&&typeof x==='object';
    const name=String(obj?x.name??x.item??'':x||'').trim().replace(/\s+/g,' ').slice(0,80);
    if(!name||name==='[object Object]'||NOT_FOOD.test(name)||!/[\p{L}]/u.test(name))continue;
    if(out.some(r=>norm(r.name)===norm(name)||covers(r.name,name)))continue;
    const q=enrich({amount:obj?x.amount:'',unit:obj?x.unit:''});
    out.push({name,qty:q.qty_num,unit:q.unit_std,approx:q.approx,unsure:obj&&!!x.unsure,have:have.some(p=>covers(p,name))});
  }
  return out;
}
/** Full pipeline for a PDF or image file. Returns {rows, source}. Throws a clear message when nothing can be read. */
export async function importReceipt(file,have=[]){
  if(file.size>MAX_FILE_BYTES)throw new Error('This file is too large (over 25 MB). Use a smaller PDF or photo, or type the items.');
  const isPdf=file.type==='application/pdf'||/\.pdf$/i.test(file.name);
  const src=isPdf?await readPdf(file):await readPhoto(file);
  const hasText=src.lines?.length>0;
  if(!hasText&&!src.images?.length)throw new Error('Nothing could be read from this file. Try a clearer photo, or type the items.');
  const o=await readReceipt({text:hasText?src.lines.join('\n'):'',images:hasText?[]:src.images});
  const rows=parseReceipt(o,have);
  return {rows,lineCount:src.lines?.length||0,scanned:!hasText};
}
