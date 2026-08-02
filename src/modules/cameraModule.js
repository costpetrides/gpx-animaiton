import { rigFromPreset, rigToShot, resolveRigAtTime, shotToRig } from '../camera/rig.js';
import { createCameraKeyframe } from '../timeline/keyframes.js';

export function resolveCameraShotFromDocument(camera, animTime = 0, duration = 0, timelineKeyframes = []) {
  const { rig, preset } = camera;
  const keyframes = timelineKeyframes?.length ? timelineKeyframes : (camera.keyframes || []);
  let activeRig = rig;
  if (keyframes.length && duration > 0) {
    activeRig = resolveRigAtTime(rig, keyframes, animTime, duration);
  }
  return rigToShot(activeRig, preset);
}

export function createCameraModule(ctx) {
  return {
    id: 'camera',
    label: 'Camera',
    icon: '📷',
    onActivate() {},
    handleIntent(intent, payload) {
      const state = ctx.getState();
      const camera = state.document.project.camera;

      if (intent === 'set-preset') {
        const preset = payload.preset === 'manual' ? 'manual' : 'cinematic';
        const rig = rigFromPreset(preset);
        ctx.dispatch({
          type: 'project/set-camera-config',
          payload: { preset, rig, shot: null },
        });
        ctx.dispatch({ type: 'project/set-camera-preset', payload: { preset } });
        ctx.animator?.setCameraFromDocument?.({ preset, rig, shot: null });
        ctx.animator?.reprepare?.('camera');
        ctx.renderProjectState?.();
        return;
      }

      if (intent === 'set-rig') {
        const rig = { ...camera.rig, ...payload.rig };
        if (payload.rig?.tiltDeg != null) {
          rig.pitchDeg = payload.rig.tiltDeg;
        }
        if (payload.rig?.focusForwardM != null) {
          rig.forwardOffsetM = payload.rig.focusForwardM;
          rig.distanceM = Math.abs(payload.rig.focusForwardM);
        }
        if (payload.rig?.focusRightM != null) {
          rig.rightOffsetM = payload.rig.focusRightM;
        }
        ctx.dispatch({ type: 'project/set-camera-rig', payload: { rig } });
        if (camera.shot?.saved) {
          ctx.dispatch({ type: 'project/reset-playback-shot' });
        }
        ctx.animator?.setCameraFromDocument?.({ ...camera, rig, shot: null });
        return;
      }

      if (intent === 'capture-shot') {
        const shot = ctx.animator?.capturePlaybackShot?.();
        if (shot) {
          const rig = shotToRig(shot, camera.preset);
          ctx.dispatch({ type: 'project/set-playback-shot', payload: { shot } });
          ctx.dispatch({ type: 'project/set-camera-rig', payload: { rig } });
          ctx.shell?.setStatus('Playback camera saved');
        }
        return;
      }

      if (intent === 'reset-shot') {
        ctx.animator?.resetPlaybackShot?.();
        ctx.dispatch({ type: 'project/reset-playback-shot' });
        ctx.shell?.setStatus('Playback camera reset');
        return;
      }

      if (intent === 'add-keyframe') {
        const animTime = ctx.animator?.getPlaybackState?.()?.animTime ?? 0;
        const kf = createCameraKeyframe(animTime, camera.rig);
        ctx.dispatch({ type: 'timeline/add-keyframe', payload: { keyframe: kf } });
        ctx.shell?.setStatus(`Camera keyframe at ${kf.label}`);
        ctx.renderProjectState?.();
        return;
      }

      if (intent === 'remove-keyframe') {
        ctx.dispatch({ type: 'timeline/remove-keyframe', payload: { id: payload.id } });
        ctx.renderProjectState?.();
      }
    },
  };
}
