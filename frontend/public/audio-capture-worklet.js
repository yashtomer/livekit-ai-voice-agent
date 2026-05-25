class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const f32 = input[0];
    const i16 = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const c = Math.max(-1, Math.min(1, f32[i]));
      i16[i] = c < 0 ? c * 32768 : c * 32767;
    }
    this.port.postMessage(i16.buffer, [i16.buffer]);
    return true;
  }
}
registerProcessor("capture-processor", CaptureProcessor);
