import logger = require('@nodejs/logger');

const { ConsoleProvider, create, levels } = logger;

const a: logger.Logger = logger();
const b: logger.Logger = create(new ConsoleProvider(), { name: 'cjs' });
const level: logger.Level = levels.fatal;
b.fatal('message', { level: level.value });

void a;
