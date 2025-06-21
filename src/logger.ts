// Simple logger with channel and severity filtering
// Usage: logger.info('TTS', 'message')
// Configure with LOG_LEVEL (DEBUG/INFO/WARN/ERROR) and LOG_CHANNELS (comma-separated)

const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const;
type LogLevel = typeof LEVELS[number];

const levelEnv = process.env.LOG_LEVEL?.toUpperCase() || 'INFO';
const channelEnv = process.env.LOG_CHANNELS || '';
const minLevel = LEVELS.includes(levelEnv as LogLevel) ? levelEnv as LogLevel : 'INFO';
const enabledChannels = channelEnv ? channelEnv.split(',').map(s => s.trim().toUpperCase()) : null;

function shouldLog(level: LogLevel, channel: string): boolean {
  const levelIdx = LEVELS.indexOf(level);
  const minIdx = LEVELS.indexOf(minLevel);
  if (levelIdx < minIdx) return false;
  if (enabledChannels && enabledChannels.length > 0) {
    return enabledChannels.includes(channel.toUpperCase());
  }
  return true;
}

function log(level: LogLevel, channel: string, ...args: any[]) {
  if (!shouldLog(level, channel)) return;
  const now = new Date().toISOString();
  const prefix = `[${now}] [${level}] [${channel}]`;
  if (level === 'ERROR') {
    console.error(prefix, ...args);
  } else if (level === 'WARN') {
    console.warn(prefix, ...args);
  } else {
    console.log(prefix, ...args);
  }
}

export const logger = {
  debug: (channel: string, ...args: any[]) => log('DEBUG', channel, ...args),
  info: (channel: string, ...args: any[]) => log('INFO', channel, ...args),
  warn: (channel: string, ...args: any[]) => log('WARN', channel, ...args),
  error: (channel: string, ...args: any[]) => log('ERROR', channel, ...args),
};
