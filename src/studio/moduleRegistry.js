export function createModuleRegistry() {
  const modules = new Map();
  let activeModuleId = 'route';

  function register(module) {
    if (!module?.id) throw new Error('Module must have an id');
    modules.set(module.id, module);
    return module;
  }

  function get(id) {
    return modules.get(id) || null;
  }

  function list() {
    return [...modules.values()];
  }

  function setActive(id) {
    if (!modules.has(id)) return false;
    activeModuleId = id;
    modules.get(id)?.onActivate?.();
    return true;
  }

  function getActive() {
    return modules.get(activeModuleId) || null;
  }

  function getActiveId() {
    return activeModuleId;
  }

  return { register, get, list, setActive, getActive, getActiveId };
}
