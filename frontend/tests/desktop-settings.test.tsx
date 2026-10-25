import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ClientSettingsDialog from '../src/components/ClientSettingsDialog';
import { defaultMediaPreferences } from '../src/lib/media';
import { checkForUpdates } from '../src/lib/desktop';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.1.1' }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: async () => null }));
vi.mock('@tauri-apps/plugin-autostart', () => ({ enable: vi.fn(), disable: vi.fn(), isEnabled: vi.fn() }));

it('shows version and in-app updates first while diagnostic tools are absent until explicitly opened', async () => {
  await checkForUpdates();
  const markup = renderToStaticMarkup(<ClientSettingsDialog section="desktop" onSectionChange={() => {}} onClose={() => {}}
    media={defaultMediaPreferences} audioProcessingState={null} onMediaChange={async () => {}} />);
  expect(markup).toContain('Версия 0.1.1');
  expect(markup).toContain('Проверить обновления');
  expect(markup.indexOf('Обновления приложения')).toBeLessThan(markup.indexOf('Окно и запуск'));
  expect(markup).toContain('<summary>Диагностика и проверки</summary>');
  expect(markup).not.toContain('Проверить захват Windows');
  expect(markup).not.toContain('Проверить исключение звука звонка');
  expect(markup).not.toContain('Отправить тест');
});
