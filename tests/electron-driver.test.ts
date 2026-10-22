import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { ElectronDriver } from '../src/electron/driver.js';

it('cleans up captured debugger listeners after WebContents destruction without touching the dead native object', async () => {
  let destroyed = false, attached = false;
  const native = Object.assign(new EventEmitter(), {
    attach: vi.fn(() => {attached=true;}),
    detach: vi.fn(() => {attached=false;}),
    isAttached: vi.fn(() => {if(destroyed) throw new Error('native access after destruction'); return attached;}),
    sendCommand: vi.fn(async () => ({})),
  });
  const contents = {isDestroyed:()=>destroyed, get debugger() {if(destroyed) throw new Error('Object has been destroyed'); return native;}} as unknown as WebContents;
  const driver = new ElectronDriver(contents, '');
  await driver.ready();
  expect(native.listenerCount('message')).toBe(1);
  destroyed=true;
  expect(() => driver.dispose()).not.toThrow();
  expect(() => driver.dispose()).not.toThrow();
  expect(native.listenerCount('message')).toBe(0);
  expect(native.listenerCount('detach')).toBe(0);
  expect(native.detach).not.toHaveBeenCalled();
  await expect(driver.ready()).rejects.toMatchObject({code:'stale_page'});
});
