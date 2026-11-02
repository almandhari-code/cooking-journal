export function pickMime(){
  for(const t of ['audio/webm;codecs=opus','audio/webm','audio/mp4'])
    if(window.MediaRecorder?.isTypeSupported?.(t))return t;
  return '';
}
const isIOS=()=>/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
const chunkMs=()=>+window.CJ_CHUNK_MS||+localStorage.getItem('cj_chunk_ms')||600000;
/** Records one session with pause/resume and cuts it into parts every chunkMs of *recorded* time
 *  (default 10 min; override with window.CJ_CHUNK_MS or localStorage cj_chunk_ms) so each part is a
 *  small file, well under Groq's 25 MB limit. stop() resolves to Blob[].
 *  Two ways to cut:
 *   - overlap (default): a second MediaRecorder on the same stream starts before the first stops, so no audio is lost.
 *   - single (iOS/Safari, or if a second recorder cannot start): ONE recorder with start(timeslice); a part is the
 *     window of timeslices since the last cut, prefixed with the recorder's first (init) chunk so it decodes alone. */
export class Recorder{
  constructor(){
    this.chunkMs=chunkMs();
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
    this.single=window.CJ_SINGLE_RECORDER??(isIOS()||/mp4/.test(pickMime()));
    this.rec=this.cur=this._begin(this.single);
    this.segMs=0;this.last=performance.now();
    this.timer=setInterval(()=>this._tick(),200);
    this._vis=()=>{if(document.visibilityState==='visible')this._wake()}; // the browser drops the lock when the page is hidden
    document.addEventListener('visibilitychange',this._vis);
    this._wake();
  }
  /** Keep the screen on while recording (iOS suspends a locked page and the recording with it). */
  async _wake(){
    if(!navigator.wakeLock||this.stopped||(this.lock&&!this.lock.released))return;
    try{const l=await navigator.wakeLock.request('screen');
      if(this.stopped)l.release().catch(()=>{});else this.lock=l}catch{}
  }
  _begin(single){
    const mime=pickMime();
    const rec=new MediaRecorder(this.stream,{...(mime?{mimeType:mime}:{}),audioBitsPerSecond:48000});
    Object.assign(rec,{single,chunks:[],init:null,cuts:0,cutting:false});
    rec.ondataavailable=e=>{
      if(!e.data.size)return;
      rec.init??=e.data;rec.chunks.push(e.data);
      if(rec.cutting){rec.cutting=false;this.parts.push(this._blob(rec));rec.cuts++;rec.chunks=[]}
      this._notify();
    };
    rec.finished=new Promise(res=>{rec.onstop=()=>{
      if(rec.single&&rec.cuts&&rec.chunks.length<=1&&this.parts.length) // stopped right after a cut: this sliver just continues the last part
        this.parts.push(new Blob([this.parts.pop(),...rec.chunks],{type:rec.mimeType||'audio/webm'}));
      else if(rec.chunks.length)this.parts.push(this._blob(rec));
      this._notify();res();
    }});
    single?rec.start(Math.min(5000,this.chunkMs)):rec.start();
    return rec;
  }
  /** A standalone file for a recorder's current window. Later windows of a single recorder need its init chunk in front. */
  _blob(rec){return new Blob([...(rec.single&&rec.cuts?[rec.init]:[]),...rec.chunks],{type:rec.mimeType||'audio/webm'})}
  /** Tell the owner what is safe to store: finished parts plus the partial segment still being recorded. */
  _notify(){
    const c=this.cur;
    this.onChange?.(this.parts.slice(),c&&c.chunks.length?this._blob(c):null);
  }
  /** Ask the browser to hand over audio recorded so far (page is being hidden or closed). */
  flush(){const c=this.cur;if(c&&c.state!=='inactive')try{c.requestData()}catch{}}
  _tick(){
    const now=performance.now(),dt=now-this.last;this.last=now;
    if(this.paused)return;
    this.ms+=dt;this.segMs+=dt;
    if(this.segMs<this.chunkMs)return;
    this.segMs=0;
    const old=this.rec;
    if(old.single){old.cutting=true;try{old.requestData()}catch{}return} // the part is closed when that data arrives
    try{this.rec=this.cur=this._begin(false);old.stop()} // start the next chunk first so no audio is lost, then close the old one
    catch{this.rec=old;this.cur=old;this._toSingle(old)} // a second recorder on this stream is not supported
  }
  /** Give up overlapping: close the old recorder and carry on with one timesliced recorder (a gap of a few ms at the switch). */
  async _toSingle(old){
    this.single=true;
    if(old.state!=='inactive')old.stop();
    await old.finished;
    if(this.stopped)return;
    this.rec=this.cur=this._begin(true);
  }
  pause(){if(this.paused)return;this.rec.pause();this.paused=true;this.pauses++}
  resume(){if(!this.paused)return;this.rec.resume();this.paused=false;this.last=performance.now()}
  async stop(){
    clearInterval(this.timer);this.stopped=true;
    document.removeEventListener('visibilitychange',this._vis);
    this.lock?.release().catch(()=>{});this.lock=null;
    const rec=this.rec;this.cur=null;
    if(rec.state!=='inactive')rec.stop();
    await rec.finished;
    this.stream.getTracks().forEach(t=>t.stop());
    // earlier rotated recorders may still be flushing; parts are pushed in stop order
    await new Promise(r=>setTimeout(r,0));
    return this.parts;
  }
}
