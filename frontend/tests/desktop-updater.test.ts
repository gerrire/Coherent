import { beforeEach, expect, it, vi } from 'vitest';
const plugin = vi.hoisted(() => ({ check: vi.fn(), relaunch: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: plugin.check }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: plugin.relaunch }));
vi.mock('@tauri-apps/plugin-autostart', () => ({ enable: vi.fn(), disable: vi.fn(), isEnabled: vi.fn() }));
beforeEach(() => { vi.resetModules(); plugin.check.mockReset(); plugin.relaunch.mockReset(); });

it('keeps a running call intact when the user clicks update', async () => {
  const release = { download: vi.fn(), install: vi.fn() };
  plugin.check.mockResolvedValue(release);
  const updates = await import('../src/lib/desktop');
  await updates.checkForUpdates();
  updates.setUpdateMediaBusy(true);
  await updates.installUpdate();
  expect(release.download).not.toHaveBeenCalled();
  expect(release.install).not.toHaveBeenCalled();
  expect(plugin.relaunch).not.toHaveBeenCalled();
});

it('defers installation if a call starts during download, then reuses the verified download', async () => {
  let finish!: () => void;
  const release = { download: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })), install: vi.fn().mockResolvedValue(undefined) };
  plugin.check.mockResolvedValue(release);
  const updates = await import('../src/lib/desktop');
  await updates.checkForUpdates();
  const installing = updates.installUpdate();
  updates.setUpdateMediaBusy(true); finish();
  await installing;
  expect(release.install).not.toHaveBeenCalled();
  updates.setUpdateMediaBusy(false);
  await updates.installUpdate();
  expect(release.download).toHaveBeenCalledOnce();
  expect(release.install).toHaveBeenCalledOnce();
  expect(plugin.relaunch).toHaveBeenCalledOnce();
});
