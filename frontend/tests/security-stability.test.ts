import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { MessageChannel } from 'node:worker_threads';
import { afterEach, expect, it, vi } from 'vitest';
import { decodeVault, encodeVault } from '../src/lib/crypto/browserVault';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false, invoke: vi.fn() }));
afterEach(() => vi.useRealTimers());

it('reads a legacy vault and round-trips binary state and its durable outbox', () => {
  const outbox = [{id:'saved-operation',operation:'send',payload:{wire:'opaque-packet'}}];
  const legacy = new TextEncoder().encode(JSON.stringify({engine:[0,128,255,1],outbox}));
  const loaded = decodeVault(legacy);
  expect([...loaded.engine]).toEqual([0,128,255,1]);
  const binary = encodeVault(loaded);
  expect(new TextDecoder().decode(binary.slice(0,9))).toBe('CohVault2');
  expect(decodeVault(binary)).toEqual(loaded);
  expect(decodeVault(binary).outbox).toEqual(outbox);
});

it('rejects truncated binary lengths instead of restoring a partial ratchet', () => {
  const encoded = encodeVault({engine:new Uint8Array([1,2,3]),outbox:[]});
  new DataView(encoded.buffer).setUint32(9,0xffffffff,false);
  expect(() => decodeVault(encoded)).toThrow();
  expect(() => decodeVault(new TextEncoder().encode('CohVault2'))).toThrow();
});

function serviceWorker(windows: unknown[]) {
  const listeners = new Map<string,(event:unknown)=>void>();
  const showNotification=vi.fn().mockResolvedValue(undefined);
  const openWindow=vi.fn().mockResolvedValue(undefined);
  runInNewContext(readFileSync(new URL('../public/sw.js',import.meta.url),'utf8'), {
    self:{addEventListener:(name:string,fn:(event:unknown)=>void)=>listeners.set(name,fn),clients:{matchAll:async()=>windows,openWindow},registration:{showNotification},location:{origin:'https://coherent.test'}},
    URL,MessageChannel,setTimeout,clearTimeout,Promise,
  });
  return {listeners,showNotification,openWindow};
}

it('shows push when the visible page does not acknowledge delivery', async () => {
  vi.useFakeTimers();
  const client={visibilityState:'visible',postMessage:vi.fn()};
  const sw=serviceWorker([client]);let pending:Promise<unknown>=Promise.resolve();
  sw.listeners.get('push')!({data:{json:()=>({title:'Когерент',tag:'message-1'})},waitUntil:(value:Promise<unknown>)=>{pending=value;}});
  await vi.advanceTimersByTimeAsync(1100);await pending;
  expect(client.postMessage).toHaveBeenCalled();expect(sw.showNotification).toHaveBeenCalledTimes(1);
});

it('opens a chat through the existing page without navigating or reloading it', async () => {
  const client={url:'https://coherent.test/',focus:vi.fn().mockResolvedValue(undefined),navigate:vi.fn(),postMessage:(_message:unknown,ports:MessagePort[])=>{ports[0].postMessage({handled:true});ports[0].close();}};
  const sw=serviceWorker([client]);let pending:Promise<unknown>=Promise.resolve();
  sw.listeners.get('notificationclick')!({notification:{close:vi.fn(),data:{url:'/?conversation=target'}},waitUntil:(value:Promise<unknown>)=>{pending=value;}});
  await pending;
  expect(client.focus).toHaveBeenCalled();expect(client.navigate).not.toHaveBeenCalled();expect(sw.openWindow).not.toHaveBeenCalled();
});
