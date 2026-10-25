import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const read = (file: string) => readFileSync(new URL('../src-tauri/' + file, import.meta.url), 'utf8');

it('requires explicit command permissions and keeps media/updating out of the call overlay', () => {
  const registered = [...read('src/lib.rs').match(/generate_handler!\[([\s\S]*?)\]/)![1].matchAll(/\w+::(\w+)/g)].map(match => match[1]).sort();
  const declared = [...read('commands.rs').matchAll(/"(\w+)"/g)].map(match => match[1]).sort();
  expect(declared).toEqual(registered);
  expect(JSON.parse(read('capabilities/default.json')).windows).toEqual(['main']);
  expect(read('permissions/overlay.toml')).not.toMatch(/"(?:start_system_audio|desktop_screen_start|desktop_settings_set|desktop_theme_set)"/);
  expect(JSON.parse(read('capabilities/call-overlay.json')).permissions).toEqual(['core:event:allow-emit', 'overlay-client']);
});
