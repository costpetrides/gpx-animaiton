import { projectCoordinateToRoute } from './photoPlacement.js';

const PROGRESS_EPSILON = 0.005;
const REWIND_TOLERANCE = 0.001;

function photoFeatureCollection(photos) {
  return {
    type: 'FeatureCollection',
    features: (photos || [])
      .filter((photo) => Number.isFinite(photo.lat) && Number.isFinite(photo.lng))
      .map((photo) => ({
        type: 'Feature',
        properties: { id: photo.id },
        geometry: { type: 'Point', coordinates: [photo.lng, photo.lat] },
      })),
  };
}

export function createPhotoController({
  map,
  store,
  getRoute,
  getAnimator,
  shell,
}) {
  let manualPlacementId = null;
  let previousProgress = 0;
  let activePhotoId = null;
  let closeTimer = null;
  let resumeAfterQueue = false;
  let queue = [];
  const shownIds = new Set();

  const overlay = document.getElementById('photo-moment');
  const image = document.getElementById('photo-moment-image');
  const title = document.getElementById('photo-moment-title');
  const meta = document.getElementById('photo-moment-meta');
  const progressBar = document.getElementById('photo-moment-progress');

  function photos() {
    return store.getState().document.project.media?.photos || [];
  }

  function ensureLayers() {
    if (!map?.isStyleLoaded?.()) return;
    if (!map.getSource('photo-markers')) {
      map.addSource('photo-markers', {
        type: 'geojson',
        data: photoFeatureCollection(photos()),
      });
    }
    if (!map.getLayer('photo-marker-glow')) {
      map.addLayer({
        id: 'photo-marker-glow',
        type: 'circle',
        source: 'photo-markers',
        paint: {
          'circle-radius': 9,
          'circle-color': '#0f9ad1',
          'circle-opacity': 0.14,
          'circle-blur': 0.55,
        },
      });
    }
    if (!map.getLayer('photo-marker-core')) {
      map.addLayer({
        id: 'photo-marker-core',
        type: 'circle',
        source: 'photo-markers',
        paint: {
          'circle-radius': 4,
          'circle-color': '#0f9ad1',
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#ffffff',
        },
      });
    }
  }

  function syncMarkers() {
    try {
      ensureLayers();
      map.getSource('photo-markers')?.setData(photoFeatureCollection(photos()));
    } catch {
      // Style may still be settling; the next sync will retry.
    }
  }

  function clearTimer() {
    if (closeTimer != null) {
      window.clearTimeout(closeTimer);
      closeTimer = null;
    }
  }

  function hideOverlay() {
    clearTimer();
    overlay?.classList.remove('is-visible');
    overlay?.setAttribute('aria-hidden', 'true');
    if (progressBar) {
      progressBar.style.animation = 'none';
      progressBar.style.width = '0%';
    }
    activePhotoId = null;
  }

  function showPhoto(photo, { autoClose = true } = {}) {
    if (!photo || !overlay || !image) return;
    clearTimer();
    activePhotoId = photo.id;
    image.src = photo.url || '';
    image.alt = photo.title || photo.originalFileName || 'Route photo';
    if (title) {
      title.textContent = photo.title || '';
      title.classList.toggle('hidden', !photo.title);
    }
    if (meta) {
      const source = photo.placementSource === 'manual'
        ? 'Manual'
        : photo.placementSource === 'gps'
          ? 'GPS'
          : photo.placementSource === 'timestamp'
            ? 'Time'
            : '';
      meta.textContent = source;
      meta.classList.toggle('hidden', !source);
    }

    overlay.style.setProperty('--photo-moment-ms', `${photo.displayDurationMs || 3000}ms`);
    overlay.classList.remove('is-visible');
    void overlay.offsetWidth;
    overlay.classList.add('is-visible');
    overlay.setAttribute('aria-hidden', 'false');

    if (progressBar) {
      progressBar.style.animation = 'none';
      progressBar.style.width = '0%';
      void progressBar.offsetWidth;
      progressBar.style.animation = `photo-moment-progress ${photo.displayDurationMs || 3000}ms linear forwards`;
    }

    if (autoClose) {
      closeTimer = window.setTimeout(() => {
        closeTimer = null;
        finishActivePhoto();
      }, Math.max(500, photo.displayDurationMs || 3000));
    }
  }

  function openNextQueuedPhoto() {
    const nextId = queue.shift();
    if (!nextId) {
      hideOverlay();
      if (resumeAfterQueue) {
        resumeAfterQueue = false;
        getAnimator()?.play?.();
      }
      return;
    }
    const photo = photos().find((item) => item.id === nextId);
    if (!photo) {
      openNextQueuedPhoto();
      return;
    }
    showPhoto(photo);
  }

  function finishActivePhoto() {
    hideOverlay();
    if (queue.length) {
      window.setTimeout(openNextQueuedPhoto, 0);
      return;
    }
    if (resumeAfterQueue) {
      resumeAfterQueue = false;
      getAnimator()?.play?.();
    }
  }

  function triggerPhotos(previous, current) {
    const lower = Math.max(0, previous - PROGRESS_EPSILON);
    const upper = Math.min(1, current);
    return photos()
      .filter((photo) => (
        Number.isFinite(photo.progress) &&
        !shownIds.has(photo.id) &&
        !queue.includes(photo.id) &&
        photo.progress >= lower &&
        photo.progress <= upper
      ))
      .sort((a, b) => a.progress - b.progress);
  }

  function onPlaybackProgress(progress, isPlaying) {
    const current = Math.max(0, Math.min(1, Number(progress) || 0));
    if (current + REWIND_TOLERANCE < previousProgress) {
      shownIds.clear();
      queue = [];
      resumeAfterQueue = false;
      hideOverlay();
    }

    if (!isPlaying || activePhotoId) {
      previousProgress = current;
      return;
    }

    const triggered = triggerPhotos(previousProgress, current);
    previousProgress = current;
    if (!triggered.length) return;

    triggered.forEach((photo) => shownIds.add(photo.id));
    queue.push(...triggered.map((photo) => photo.id));
    resumeAfterQueue = true;
    getAnimator()?.pause?.();
    openNextQueuedPhoto();
  }

  function resetPlaybackTriggers(progress = 0) {
    previousProgress = Math.max(0, Math.min(1, Number(progress) || 0));
    shownIds.clear();
    queue = [];
    resumeAfterQueue = false;
    hideOverlay();
  }

  function placePhotoAt(photoId, lngLat, source = 'manual') {
    const route = getRoute?.();
    if (!route || !lngLat) return false;
    const placement = projectCoordinateToRoute(route, lngLat.lat, lngLat.lng);
    if (!placement) return false;

    store.dispatch({
      type: 'project/update-photo',
      payload: {
        id: photoId,
        patch: {
          lat: placement.lat,
          lng: placement.lng,
          routeDistanceM: placement.routeDistanceM,
          progress: placement.progress,
          placementSource: source,
        },
      },
    });
    syncMarkers();
    return true;
  }

  function setManualPlacement(photoId) {
    const photo = photos().find((item) => item.id === photoId);
    if (!photo) return;
    manualPlacementId = photoId;
    const canvas = map.getCanvas?.();
    if (canvas) canvas.style.cursor = 'crosshair';
    shell?.setStatus?.(`Click the route to place ${photo.originalFileName || 'photo'}`);
  }

  function cancelManualPlacement() {
    manualPlacementId = null;
    const canvas = map.getCanvas?.();
    if (canvas) canvas.style.cursor = '';
  }

  function placePendingAt(lngLat) {
    if (!manualPlacementId) return false;
    const placedId = manualPlacementId;
    if (!placePhotoAt(placedId, lngLat, 'manual')) return false;
    const placed = photos().find((item) => item.id === placedId);
    cancelManualPlacement();
    shell?.setStatus?.(
      placed
        ? `Placed ${placed.originalFileName || 'photo'} on the route`
        : 'Photo placed on the route',
    );
    return true;
  }

  function previewPhoto(photoId) {
    const photo = photos().find((item) => item.id === photoId);
    if (!photo) return;
    const animator = getAnimator?.();
    if (animator?.isPlaying?.()) animator.pause();
    showPhoto(photo, { autoClose: true });
  }

  map.on('click', (event) => {
    if (placePendingAt(event.lngLat)) return;

    const features = map.queryRenderedFeatures?.(event.point, {
      layers: map.getLayer('photo-marker-core') ? ['photo-marker-core'] : [],
    }) || [];
    const id = features[0]?.properties?.id;
    if (id) previewPhoto(id);
  });

  return {
    syncMarkers,
    setManualPlacement,
    placePhotoAt,
    cancelManualPlacement,
    onPlaybackProgress,
    resetPlaybackTriggers,
    previewPhoto,
    destroy() {
      cancelManualPlacement();
      hideOverlay();
    },
  };
}
