# Ryodo mobile renderer profile

The desktop GPX editor remains a full authoring tool. Ryodo mobile uses the same
rendering code with a deliberately smaller host surface.

## Locked mobile behaviour

- Export is always portrait `9:16`.
- Export defaults remain `1080p / 30 fps / MP4`.
- Camera mode is cinematic; the mobile host exposes no zoom-in/zoom-out,
  distance, stability, or camera-mode controls.
- The only map-style choice is the existing three-style set:
  `Outdoor`, `Positron`, and `Dark`.
- The renderer does not open a photo picker on mobile.
- Photos are supplied by the Ryodo host and only `kind: "route"` photos are
  accepted. These are the photos the user selected from the recording flow.
- The current three-film-stat overlay remains Elevation, Distance, and Speed.

## Boundary

`src/mobile/ryodoMobileProfile.js` is the source of truth for the mobile
product surface. It is intentionally pure and DOM-free so the Ryodo app can
consume the profile without importing the desktop editor UI.

The desktop application is unchanged. Future Ryodo integration should feed
activity route data and selected route photos directly into the shared renderer
rather than simulating GPX/photo file-picker interactions.
