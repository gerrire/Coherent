import { afterEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import MediaSettingsPanel from '../src/components/MediaSettingsPanel';
import { defaultMediaPreferences, screenSharePublish, supportedVideoCodec } from '../src/lib/media';
import { toneAmplitude } from '../src/lib/checkCallAudioIsolation';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());
function codecs() {
  vi.stubGlobal('RTCRtpSender', { getCapabilities: () => ({ codecs: ['VP8', 'VP9', 'H264', 'AV1'].map(codec => ({ mimeType: 'video/' + codec })) }) });
}

it('offers the desktop user the saved full-quality controls and supported codecs', () => {
  codecs();
  const media = { ...defaultMediaPreferences, screenShareQuality: '2160p' as const, screenShareFrameRate: 60 as const, screenShareBitrateMbps: 50, screenShareCodec: 'vp9' as const };
  const markup = renderToStaticMarkup(<MediaSettingsPanel media={media} audioProcessingState={null} onChange={async () => {}} onClose={() => {}} />);
  expect(markup).toContain('value="2160p" selected=""');
  expect(markup).toContain('value="60" selected=""');
  expect(markup).toContain('value="vp9" selected=""');
  expect(markup).toContain('max="50"');
  expect(markup).toContain('value="50"');
  for (const codec of ['h264', 'vp8', 'vp9', 'av1']) expect(markup).toContain(`value="${codec}"`);
  expect(markup).not.toContain('Режим стабильности');
  expect(screenSharePublish(media)).toMatchObject({ videoCodec: 'vp9', screenShareEncoding: { maxBitrate: 50_000_000, maxFramerate: 60 } });
});

it('passes every supported screen codec and only falls back for an unavailable encoder', () => {
  codecs();
  for (const codec of ['h264', 'vp8', 'vp9', 'av1'] as const) expect(supportedVideoCodec(codec)).toBe(codec);
  vi.stubGlobal('RTCRtpSender', { getCapabilities: () => ({ codecs: [{ mimeType: 'video/VP8' }] }) });
  expect(supportedVideoCodec('av1')).toBe('vp8');
});

it('detects leaked received audio even with opposite stereo phase, without mistaking the external control tone', () => {
  const tone = (hz: number) => Int16Array.from({ length: 1920 }, (_, i) => Math.round(Math.sin(2 * Math.PI * hz * Math.floor(i / 2) / 48000) * 5000 * (i % 2 ? -1 : 1)));
  expect(toneAmplitude(tone(1800), 1800)).toBeGreaterThan(0.15);
  expect(toneAmplitude(tone(1000), 1800)).toBeLessThan(0.0001);
  expect(toneAmplitude(new Int16Array(1920), 1800)).toBe(0);
});
