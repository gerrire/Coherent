// Development-only CDP driver for this project's own Windows and browser clients.
// Never enable a debugging port in packaged production configuration.
export class Cdp {
  constructor(socket) {
    this.socket = socket; this.pending = new Map(); this.nextId = 1;
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Test client closed')); }
      this.pending.clear();
    });
  }
  static async connect(port, match) {
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        const target = targets.find(t => t.type === 'page' && match(t));
        if (target) {
          const socket = new WebSocket(target.webSocketDebuggerUrl);
          await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
          return new Cdp(socket);
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Test client did not open its debugging target');
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 45000);
      this.pending.set(id, {resolve, reject, timer});
      this.socket.send(JSON.stringify({id, method, params}));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {expression, awaitPromise:true, returnByValue:true, userGesture:true});
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  close() { this.socket.close(); }
}

export const instrumentation = `
globalThis.__qaPeers = [];
const OriginalPeerConnection = globalThis.RTCPeerConnection;
globalThis.RTCPeerConnection = class extends OriginalPeerConnection {
  constructor(...args) { super(...args); globalThis.__qaPeers.push(this); }
};
localStorage.setItem('coherent.media-preferences', JSON.stringify({
  microphoneEnabled:false, cameraEnabled:false, systemAudioEnabled:true,
  qualityDefaultsVersion:2, screenShareDefaultsVersion:1, screenShareBitrateDefaultsVersion:1
}));
`;

export const peerStats = `(async()=>{
  const peers=[];
  for(const pc of globalThis.__qaPeers??[]){
    const report=await pc.getStats();
    peers.push({state:pc.connectionState, reports:[...report.values()].filter(s=>
      ['inbound-rtp','outbound-rtp','codec','candidate-pair','remote-inbound-rtp'].includes(s.type)
    ).map(s=>{
      const out={};
      for(const k of ['id','type','kind','codecId','mimeType','sdpFmtpLine','frameWidth','frameHeight','framesPerSecond','framesEncoded','framesDecoded','framesReceived','framesSent','bytesReceived','bytesSent','packetsLost','jitter','currentRoundTripTime','totalAudioEnergy','totalSamplesReceived','qualityLimitationReason','state','nominated','timestamp'])
        if(s[k]!==undefined)out[k]=s[k];
      return out;
    })});
  }
  return {peers, videos:[...document.querySelectorAll('video')].map(v=>({width:v.videoWidth,height:v.videoHeight,time:v.currentTime,ready:v.readyState,frames:v.getVideoPlaybackQuality().totalVideoFrames}))};
})()`;
