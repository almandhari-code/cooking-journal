export function pickMime(){
  for(const t of ['audio/webm;codecs=opus','audio/webm','audio/mp4'])
    if(window.MediaRecorder?.isTypeSupported?.(t))return t;
  return '';
}
export class Recorder{
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
    const mime=pickMime();
    this.chunks=[];
    this.rec=new MediaRecorder(this.stream,mime?{mimeType:mime}:undefined);
    this.rec.ondataavailable=e=>e.data.size&&this.chunks.push(e.data);
    this.rec.start();
  }
  stop(){
    return new Promise(res=>{
      this.rec.onstop=()=>{
        this.stream.getTracks().forEach(t=>t.stop());
        res(new Blob(this.chunks,{type:this.rec.mimeType||'audio/webm'}));
      };
      this.rec.stop();
    });
  }
}
