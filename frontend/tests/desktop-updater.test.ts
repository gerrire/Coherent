import { beforeEach, expect, it, vi } from 'vitest';
const plugin = vi.hoisted(() => ({ check: vi.fn(), relaunch: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.1.0' }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: plugin.check }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: plugin.relaunch }));
vi.mock('@tauri-apps/plugin-autostart', () => ({ enable: vi.fn(), disable: vi.fn(), isEnabled: vi.fn() }));
beforeEach(() => { vi.resetModules(); plugin.check.mockReset(); plugin.relaunch.mockReset(); });
const release = () => ({ version: '0.1.1', body: 'Обновление клиента', currentVersion: '0.1.0',
  download: vi.fn().mockResolvedValue(undefined), install: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) });

it('keeps a running call intact when the user clicks install', async () => {
  const candidate = release(); plugin.check.mockResolvedValue(candidate);
  const updates = await import('../src/lib/desktop');
  await updates.checkForUpdates(); updates.setUpdateMediaBusy(true);
  await updates.installUpdate();
  expect(candidate.download).not.toHaveBeenCalled();
  expect(candidate.install).not.toHaveBeenCalled();
  expect(plugin.relaunch).not.toHaveBeenCalled();
  expect(updates.getUpdateState()).toMatchObject({ currentVersion: '0.1.0', version: '0.1.1', callActive: true });
  expect(plugin.check).toHaveBeenCalledWith({ timeout: 20000 });
});

it('defers installation if a call starts during download and reuses the verified download', async () => {
  let finish!: () => void;
  const candidate = release();
  candidate.download.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  plugin.check.mockResolvedValue(candidate);
  const updates = await import('../src/lib/desktop'); await updates.checkForUpdates();
  const installing = updates.installUpdate();
  updates.setUpdateMediaBusy(true); finish(); await installing;
  expect(candidate.install).not.toHaveBeenCalled();
  expect(updates.getUpdateState()).toMatchObject({ downloaded: true, callActive: true, busy: false });
  updates.setUpdateMediaBusy(false);
  expect(candidate.install).not.toHaveBeenCalled();
  await updates.installUpdate();
  expect(candidate.download).toHaveBeenCalledOnce();
  expect(candidate.install).toHaveBeenCalledWith({ restartAfterInstall: true });
  expect(plugin.relaunch).not.toHaveBeenCalled();
});

it('reports progress, waits for signature verification and never installs on download alone', async () => {
  let progress!: (event: any) => void, finish!: () => void;
  const candidate = release();
  candidate.download.mockImplementation(callback => { progress = callback; return new Promise<void>(resolve => { finish = resolve; }); });
  plugin.check.mockResolvedValue(candidate);
  const updates = await import('../src/lib/desktop'); await updates.checkForUpdates();
  updates.setUpdateMediaBusy(true);
  const downloading = updates.downloadUpdate();
  progress({ event: 'Started', data: { contentLength: 1000 } });
  progress({ event: 'Progress', data: { chunkLength: 400 } });
  expect(updates.getUpdateState()).toMatchObject({ phase: 'downloading', downloadedBytes: 400, totalBytes: 1000, progress: 40, downloaded: false });
  progress({ event: 'Finished' });
  expect(updates.getUpdateState().downloaded).toBe(false);
  finish(); await downloading;
  expect(updates.getUpdateState()).toMatchObject({ phase: 'ready', downloaded: true, progress: 100, busy: false });
  expect(candidate.install).not.toHaveBeenCalled();
  progress({ event: 'Progress', data: { chunkLength: 900 } });
  expect(updates.getUpdateState().phase).toBe('ready');
});

it('does not install a package whose download or signature check failed', async () => {
  const candidate = release(); candidate.download.mockRejectedValue(new Error('signature invalid'));
  plugin.check.mockResolvedValue(candidate);
  const updates = await import('../src/lib/desktop'); await updates.checkForUpdates();
  await updates.installUpdate();
  expect(candidate.install).not.toHaveBeenCalled();
  expect(updates.getUpdateState()).toMatchObject({ phase: 'error', downloaded: false, busy: false });
});

it('downloads afresh after an installer launch failure and leaves the client usable', async () => {
  const candidate = release(); candidate.install.mockRejectedValueOnce(new Error('launch failed'));
  plugin.check.mockResolvedValue(candidate);
  const updates = await import('../src/lib/desktop'); await updates.checkForUpdates();
  await updates.installUpdate();
  expect(updates.getUpdateState()).toMatchObject({ phase: 'error', downloaded: false, busy: false });
  await updates.installUpdate();
  expect(candidate.download).toHaveBeenCalledTimes(2);
  expect(candidate.install).toHaveBeenCalledTimes(2);
});

it('preserves an already verified package across repeated checks for the same release', async () => {
  const original = release(), sameVersion = release();
  plugin.check.mockResolvedValueOnce(original).mockResolvedValueOnce(sameVersion);
  const updates = await import('../src/lib/desktop'); await updates.checkForUpdates(); await updates.downloadUpdate();
  await updates.checkForUpdates();
  expect(sameVersion.close).toHaveBeenCalledOnce(); expect(original.close).not.toHaveBeenCalled();
  await updates.installUpdate();
  expect(original.download).toHaveBeenCalledOnce(); expect(original.install).toHaveBeenCalledOnce();
  expect(sameVersion.download).not.toHaveBeenCalled();
});

it('retains a verified download if the next network check fails', async () => {
  const candidate = release();
  plugin.check.mockResolvedValueOnce(candidate).mockRejectedValueOnce(new Error('offline'));
  const updates = await import('../src/lib/desktop'); await updates.checkForUpdates(); await updates.downloadUpdate();
  await updates.checkForUpdates();
  expect(updates.getUpdateState()).toMatchObject({ phase: 'error', downloaded: true, available: true, busy: false });
  await updates.installUpdate(); expect(candidate.download).toHaveBeenCalledOnce(); expect(candidate.install).toHaveBeenCalledOnce();
});

it('releases the previous package when a newer release replaces it', async () => {
  const original = release(), newer = { ...release(), version: '0.1.2' };
  plugin.check.mockResolvedValueOnce(original).mockResolvedValueOnce(newer);
  const updates = await import('../src/lib/desktop'); await updates.checkForUpdates(); await updates.downloadUpdate();
  await updates.checkForUpdates();
  expect(original.close).toHaveBeenCalledOnce();
  expect(updates.getUpdateState()).toMatchObject({ version: '0.1.2', downloaded: false, progress: null });
});
