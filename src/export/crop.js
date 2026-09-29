export function getAspectRatioValue(ratio) {
  if (ratio === '16:9') return 16 / 9;
  if (ratio === '1:1') return 1;
  return 9 / 16;
}

export function getCropPreviewMetrics(width, height, ratio) {
  const containerAspect = width / height;
  const targetAspect = getAspectRatioValue(ratio);

  if (containerAspect > targetAspect) {
    const cropW = height * targetAspect;
    const bar = (width - cropW) / 2;
    return {
      left: bar,
      right: bar,
      top: 0,
      bottom: 0,
      frameLeft: bar,
      frameTop: 0,
      frameWidth: cropW,
      frameHeight: height,
    };
  }

  const cropH = width / targetAspect;
  const bar = (height - cropH) / 2;
  return {
    left: 0,
    right: 0,
    top: bar,
    bottom: bar,
    frameLeft: 0,
    frameTop: bar,
    frameWidth: width,
    frameHeight: cropH,
  };
}

export function getCropRegion(containerWidth, containerHeight, recordW, recordH) {
  const targetAspect = recordW / recordH;
  const containerAspect = containerWidth / containerHeight;
  let cropX = 0;
  let cropY = 0;
  let cropW = containerWidth;
  let cropH = containerHeight;

  if (targetAspect < containerAspect - 0.01) {
    cropW = containerHeight * targetAspect;
    cropX = (containerWidth - cropW) / 2;
  } else if (targetAspect > containerAspect + 0.01) {
    cropH = containerWidth / targetAspect;
    cropY = (containerHeight - cropH) / 2;
  }

  return { cropX, cropY, cropW, cropH };
}
