# Playback architecture

The default film pipeline follows TrailReplay's playback practices while keeping
this project's own OpenFreeMap/MapLibre styles and Mapterhorn terrain.

Sequence:

1. panoramic route overview
2. 1.5 s cinematic fly-in to the first playback pose
3. fixed 30 s route replay at 1×, paced uniformly by route progress
4. 3 s panoramic outro
5. the same sequence is captured by MP4 export

The steady playback camera is deterministic from route progress, with stable
route bearing and restrained terrain-aware zoom/pitch adjustments. DEM handling
is a safety/clearance layer rather than a per-frame cinematic shot selector.

## Product shells

The desktop GPX editor is the full authoring surface.

Ryodo mobile is a constrained shell over the same renderer. Its product contract
lives in `src/mobile/ryodoMobileProfile.js`: fixed portrait 9:16 cinematic MP4,
only Outdoor/Positron/Dark map-style selection, no user zoom/camera controls, and
route photos supplied by the host app rather than imported inside the renderer.
