export function serializeProjectDocument(document) {
  return JSON.stringify(document, null, 2);
}

const MAX_PROJECT_JSON_BYTES = 12 * 1024 * 1024;

export function deserializeProjectDocument(json) {
  if (typeof json === 'string' && json.length > MAX_PROJECT_JSON_BYTES) {
    throw new Error('Project file is too large');
  }

  let parsed;
  try {
    parsed = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    throw new Error('Invalid project JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid project document');
  }

  if (!parsed.project || typeof parsed.project !== 'object') {
    throw new Error('Invalid project document: missing project');
  }

  if (parsed.project.route?.points && !Array.isArray(parsed.project.route.points)) {
    throw new Error('Invalid project document: route points must be an array');
  }

  return parsed;
}
