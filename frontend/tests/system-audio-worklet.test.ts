import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

it('renders both PCM16 channels and outputs silence after the queue is exhausted', () => {
  let Processor: any;
  runInNewContext(readFileSync(new URL('../public/system-audio-worklet.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor: class { port = { onmessage: null, postMessage() {} }; },
    registerProcessor(_name: string, constructor: unknown) { Processor = constructor; },
  });
  const processor = new Processor();
  processor.port.onmessage({ data: new Int16Array([16384, -16384, 8192, -8192]) });
  const output = [new Float32Array(4), new Float32Array(4)];
  expect(processor.process([], [output])).toBe(true);
  expect([...output[0]]).toEqual([.5, .25, 0, 0]);
  expect([...output[1]]).toEqual([-.5, -.25, 0, 0]);
});
