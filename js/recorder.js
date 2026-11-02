export function pickMime(){
  for(const t of ['audio/webm;codecs=opus','audio/webm','audio/mp4'])
    if(window.MediaRecorder?.isTypeSupported?.(t))return t;
  return '';
}
/** Records one session with pause/resume. Rotates the MediaRecorder every
 *  chunkMs of *recorded* time (default 10 min) so each part is a standalone,
 *  small file (well under Groq's 25 MB limit). stop() resolves to Blob[]. */
export class Recorder{
  constructor(){
    this.chunkMs=window.CJ_CHUNK_MS||600000;
    this.parts=[];this.paused=false;this.pauses=0;this.ms=0;
  }
  get seconds(){return Math.floor(this.ms/1000)}
  async start(){
    if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder)
      throw new Error('Recording is not supported in this browser.');
    try{this.stream=await navigator.mediaDevices.getUserMedia({audio:true})}
    catch(e){
      if(e.name==='NotAllowedError'||e.name==='SecurityError')
        throw new Error('Microphone access was denied. Allow the microphone in your browser settings and try again.');
      if(e.name==='NotFoundError')throw new Error('No microphone was found on this device.');
      throw new Error('Could not start the microphone: '+e.message);
    }
    this.rec=this.cur=this._begin();
    this.segMs=0;this.last=performance.now();
    this.timer=setInterval(()=>this._tick(),200);
  }
  _begin(){
    const mime=pickMime(),chunks=[];
    const rec=new MediaRecorder(this.stream,{...(mime?{mimeType:mime}:{}),audioBitsPerSecond:48000});
    rec.chunks=chunks;
    rec.ondataavailable=e=>{if(e.data.size){chunks.push(e.data);this._notify()}};
    rec.finished=new Promise(res=>{rec.onstop=()=>{
      if(chunks.length)this.parts.push(new Blob(chunks,{type:rec.mimeType||'audio/webm'}));
      this._notify();res();
    }});
    rec.start();
    return rec;
  }
  /** Tell the owner what is safe to store: finished parts plus the partial segment still being recorded. */
  _notify(){
    const c=this.cur;
    this.onChange?.(this.parts.slice(),c&&c.chunks.length?new Blob(c.chunks,{type:c.mimeType||'audio/webm'}):null);
  }
  /** Ask the browser to hand over audio recorded so far (page is being hidden or closed). */
  flush(){const c=this.cur;if(c&&c.state!=='inactive')try{c.requestData()}catch{}}
  _tick(){
    const now=performance.now(),dt=now-this.last;this.last=now;
    if(this.paused)return;
    this.ms+=dt;this.segMs+=dt;
    if(this.segMs>=this.chunkMs){ // start the next chunk first so no audio is lost, then close the old one
      const old=this.rec;this.rec=this.cur=this._begin();this.segMs=0;old.stop();
    }
  }
  pause(){if(this.paused)return;this.rec.pause();this.paused=true;this.pauses++}
  resume(){if(!this.paused)return;this.rec.resume();this.paused=false;this.last=performance.now()}
  async stop(){
    clearInterval(this.timer);
    const rec=this.rec;this.cur=null;
    if(rec.state!=='inactive')rec.stop();
    await rec.finished;
    this.stream.getTracks().forEach(t=>t.stop());
    // earlier rotated recorders may still be flushing; parts are pushed in stop order
    await new Promise(r=>setTimeout(r,0));
    return this.parts;
  }
}
