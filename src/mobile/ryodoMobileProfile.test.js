import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RYODO_MOBILE_ALLOWED_MAP_STYLES,
  RYODO_MOBILE_RENDER_PROFILE,
  RYODO_MOBILE_UI_CAPABILITIES,
  createRyodoMobileRenderConfig,
  normalizeRyodoMobileMapStyle,
  normalizeRyodoMobileRoutePhotos,
} from './ryodoMobileProfile.js';

test('Ryodo mobile export is locked to portrait MP4', () => {
  assert.equal(RYODO_MOBILE_RENDER_PROFILE.aspectRatio, '9:16');
  assert.equal(RYODO_MOBILE_RENDER_PROFILE.format, 'mp4');
  assert.equal(RYODO_MOBILE_RENDER_PROFILE.cameraMode, 'cinematic');
  assert.equal(RYODO_MOBILE_UI_CAPABILITIES.aspectRatioPicker, false);
  assert.equal(RYODO_MOBILE_UI_CAPABILITIES.zoomControls, false);
});

test('Ryodo mobile exposes only the three existing basemap styles', () => {
  assert.deepEqual(
    [...RYODO_MOBILE_ALLOWED_MAP_STYLES],
    ['outdoor', 'positron', 'dark'],
  );
  assert.equal(normalizeRyodoMobileMapStyle('outdoor'), 'outdoor');
  assert.equal(normalizeRyodoMobileMapStyle('positron'), 'positron');
  assert.equal(normalizeRyodoMobileMapStyle('dark'), 'dark');
  assert.equal(normalizeRyodoMobileMapStyle('satellite'), 'outdoor');
  assert.equal(normalizeRyodoMobileMapStyle('unknown'), 'outdoor');
});

test('Ryodo mobile accepts route photos only', () => {
  const route = { id: 'route-1', kind: 'route' };
  const general = { id: 'general-1', kind: 'general' };
  const photos = normalizeRyodoMobileRoutePhotos([route, general, null]);

  assert.deepEqual(photos, [route]);
});

test('Ryodo mobile config keeps host choices narrow', () => {
  const route = { id: 'route-1', kind: 'route' };
  const config = createRyodoMobileRenderConfig({
    mapStyle: 'dark',
    selectedRoutePhotos: [route, { id: 'x', kind: 'general' }],
  });

  assert.equal(config.aspectRatio, '9:16');
  assert.equal(config.mapStyle, 'dark');
  assert.deepEqual(config.photos, [route]);
  assert.equal(config.ui.mapStylePicker, true);
  assert.equal(config.ui.cameraModePicker, false);
  assert.equal(config.ui.photoImportPicker, false);
});
