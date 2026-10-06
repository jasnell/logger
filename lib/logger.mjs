// ESM entry point. Re-exports the CommonJS implementation, so that `import`
// and `require()` share a single instance of the module.

import create from './logger.js';

export default create;

export const {
  AggregateProvider,
  ConsoleProvider,
  EventProvider,
  Logger,
  getDefaultProvider,
  levels,
  setDefaultProvider,
} = create;

export { create };
