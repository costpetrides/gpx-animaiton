import { ArrayBufferTarget, Muxer } from 'mp4-muxer';

export function isWebCodecsMp4Supported() {
  return (
    typeof window !== 'undefined' &&
    typeof VideoEncoder !== 'undefined' &&
    typeof VideoFrame !== 'undefined'
  );
}

function avcCandidates(width, height) {
  const area = width * height;
  if (area > 1920 * 1080) {
    return ['avc1.640034', 'avc1.640033', 'avc1.640028', 'avc1.4D4028', 'avc1.42E01E'];
  }
  return ['avc1.640028', 'avc1.4D4028', 'avc1.42E01E', 'avc1.640033'];
}

async function resolveSupportedConfig({ width, height, fps, bitrate }) {
  for (const codec of avcCandidates(width, height)) {
    const config = {
      codec,
      width,
      height,
      bitrate,
      framerate: fps,
      avc: { format: 'avc' },
      latencyMode: 'quality',
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return config;
    } catch {
      // try next profile/level
    }
  }
  return null;
}

export async function createMp4CanvasEncoder(options) {
  if (!isWebCodecsMp4Supported()) return null;

  const config = await resolveSupportedConfig(options);
  if (!config) return null;

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: 'avc',
      width: options.width,
      height: options.height,
    },
    fastStart: false,
    firstTimestampBehavior: 'offset',
  });

  let encoderError = null;
  let finalized = false;
  let lastTimestampMicros = -1;
  let lastKeyframeMicros = -2_000_000;
  const frameDurationMicros = Math.round(1_000_000 / options.fps);

  const rawFrameBytes = options.width * options.height * 4;
  const maxFramesBetweenFlushes = Math.max(
    1,
    Math.min(8, Math.floor((64 * 1024 * 1024) / rawFrameBytes)),
  );
  let framesSinceFlush = 0;

  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (error) => {
      encoderError = error instanceof Error ? error : new Error(String(error));
    },
  });
  encoder.configure(config);

  return {
    async encodeCanvas(canvas, timestampMicros, durationMicros = frameDurationMicros) {
      if (finalized) throw new Error('MP4 encoder already finalized');
      if (encoderError) throw encoderError;
      if (encoder.state !== 'configured') throw new Error('MP4 encoder is not configured');

      const timestamp = Math.max(0, Math.round(timestampMicros));
      if (timestamp <= lastTimestampMicros) return;
      lastTimestampMicros = timestamp;

      const keyFrame = timestamp - lastKeyframeMicros >= 2_000_000;
      if (keyFrame) lastKeyframeMicros = timestamp;

      const frame = new VideoFrame(canvas, {
        timestamp,
        duration: Math.max(1, Math.round(durationMicros)),
      });
      try {
        encoder.encode(frame, { keyFrame });
      } finally {
        frame.close();
      }

      framesSinceFlush += 1;
      if (encoder.encodeQueueSize >= 8 || framesSinceFlush >= maxFramesBetweenFlushes) {
        await encoder.flush();
        framesSinceFlush = 0;
        if (encoderError) throw encoderError;
      }
    },

    async finalize() {
      finalized = true;
      await encoder.flush();
      if (encoderError) throw encoderError;
      muxer.finalize();
      if (encoder.state !== 'closed') encoder.close();
      return new Blob([muxer.target.buffer], { type: 'video/mp4' });
    },

    close() {
      finalized = true;
      try {
        if (encoder.state !== 'closed') encoder.close();
      } catch {
        // already closed
      }
    },
  };
}
