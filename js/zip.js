// Minimal zip (store only, no compression): enough for our own backups, no dependencies.
const T=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c>>>0}return t})();
const crc=b=>{let c=~0;for(let i=0;i<b.length;i++)c=T[(c^b[i])&255]^(c>>>8);return ~c>>>0};
const te=new TextEncoder(),td=new TextDecoder();

/** files: [[name, Uint8Array]] -> Blob */
export function write(files){
  const out=[],cd=[];let off=0;
  for(const [name,data] of files){
    const n=te.encode(name),c=crc(data);
    const h=new DataView(new ArrayBuffer(30));
    h.setUint32(0,0x04034b50,true);h.setUint16(4,20,true);h.setUint16(6,0x0800,true); // utf-8 names
    h.setUint32(14,c,true);h.setUint32(18,data.length,true);h.setUint32(22,data.length,true);h.setUint16(26,n.length,true);
    const e=new DataView(new ArrayBuffer(46));
    e.setUint32(0,0x02014b50,true);e.setUint16(4,20,true);e.setUint16(6,20,true);e.setUint16(8,0x0800,true);
    e.setUint32(16,c,true);e.setUint32(20,data.length,true);e.setUint32(24,data.length,true);e.setUint16(28,n.length,true);e.setUint32(42,off,true);
    out.push(h,n,data);cd.push(e,n);off+=30+n.length+data.length;
  }
  const size=cd.reduce((a,x)=>a+(x.byteLength??x.length),0);
  const end=new DataView(new ArrayBuffer(22));
  end.setUint32(0,0x06054b50,true);end.setUint16(8,files.length,true);end.setUint16(10,files.length,true);end.setUint32(12,size,true);end.setUint32(16,off,true);
  return new Blob([...out,...cd,end],{type:'application/zip'});
}
/** ArrayBuffer -> Map(name -> Uint8Array). Only handles zips made by write(). */
export function read(buf){
  const v=new DataView(buf),u=new Uint8Array(buf);
  let e=buf.byteLength-22;
  while(e>=0&&v.getUint32(e,true)!==0x06054b50)e--;
  if(e<0)throw new Error('This is not a zip file.');
  const count=v.getUint16(e+10,true);let p=v.getUint32(e+16,true);
  const files=new Map();
  for(let i=0;i<count;i++){
    if(v.getUint32(p,true)!==0x02014b50)throw new Error('The zip file is damaged.');
    if(v.getUint16(p+10,true)!==0)throw new Error('This zip uses compression. Import a backup made by this app.');
    const size=v.getUint32(p+20,true),nl=v.getUint16(p+28,true),xl=v.getUint16(p+30,true),cl=v.getUint16(p+32,true),lo=v.getUint32(p+42,true);
    const name=td.decode(u.subarray(p+46,p+46+nl));
    const ds=lo+30+v.getUint16(lo+26,true)+v.getUint16(lo+28,true);
    files.set(name,u.slice(ds,ds+size));
    p+=46+nl+xl+cl;
  }
  return files;
}
