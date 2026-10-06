import { AsyncLocalStorage } from 'node:async_hooks';
import { tracingChannel } from 'node:diagnostics_channel';
import create, {
  AggregateProvider,
  ConsoleProvider,
  DiagnosticsProvider,
  EventProvider,
  Logger,
  getDefaultProvider,
  levels,
  setDefaultProvider,
} from '@nodejs/logger';
import type {
  Level,
  LogChannelMessage,
  LogEvent,
  LoggerContext,
  Provider,
} from '@nodejs/logger';

const logger: Logger = create({ name: 'example' });
logger.info('server started', { port: 3000 });
logger.log({ name: 'notice', value: 35 }, 'custom');
logger.log('warn', 'built-in');
// @ts-expect-error: unknown level name
logger.log('verbose', 'unknown');
const enabled: boolean = logger.isEnabled('debug');
const child: Logger = logger.child({ requestId: 1 }, { name: 'child' });
const name: string | undefined = child.name;

const als = new AsyncLocalStorage<number>();
create(new ConsoleProvider({ pid: true, flatten: true }), {
  bindings: { store: () => als.getStore() },
});
create(null, { name: 'default' });
new Logger();

const consoleProvider = new ConsoleProvider({
  destination: 'stderr',
  level: 'debug',
  serializer: (record) => JSON.stringify(record),
});
consoleProvider.level = 'warn';
consoleProvider.level = { name: 'custom', value: 45 };
const level: Level = consoleProvider.level;
consoleProvider.flush((err) => { if (err) throw err; });
consoleProvider.flushSync();
consoleProvider.stream.on('drop', () => {});
// @ts-expect-error: invalid destination
new ConsoleProvider({ destination: 'file' });

const eventProvider = new EventProvider({ level: 'trace' });
eventProvider.on('log', (event: LogEvent) => event.message);
eventProvider.on('warn', (event) => event.level.value);

new DiagnosticsProvider({ 'app:log': (lvl) => lvl.value >= 30 });
new DiagnosticsProvider((lvl) => (lvl.name === 'error' ? 'app:error' : undefined));

const custom: Provider = {
  isEnabled(lvl: Level, context?: LoggerContext) {
    return lvl.value >= levels.info.value && context?.name !== 'quiet';
  },
  log(event: LogEvent) {
    void event.attributes;
  },
};
new AggregateProvider([custom, eventProvider, consoleProvider]).providers;

setDefaultProvider(eventProvider);
const provider: Provider = getDefaultProvider();
// @ts-expect-error: not a provider
setDefaultProvider({});

const infoName: 'info' = levels.info.name;

process.on('defaultLoggerProviderChanged', (next, previous) => {
  const p: Provider = next;
  const q: Provider | undefined = previous;
  void p; void q;
});

tracingChannel<unknown, LogChannelMessage & object>('nodejs:logger:log')
  .subscribe({
    start(message) { message.event.attributes.traceId = 'abc'; },
    end() {},
    asyncStart() {},
    asyncEnd() {},
    error() {},
  });

void [enabled, name, level, provider, infoName];
