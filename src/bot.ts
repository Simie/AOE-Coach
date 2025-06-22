import { Client, GatewayIntentBits, VoiceState, TextChannel } from 'discord.js';
import {
  joinVoiceChannel,
  EndBehaviorType,
  getVoiceConnection, getVoiceConnections,
  VoiceConnection,
  VoiceReceiver,
  createAudioResource, StreamType, AudioPlayerStatus, createAudioPlayer
} from '@discordjs/voice';
import { createClient as createDeepgramClient } from '@deepgram/sdk';
import * as dotenv from 'dotenv';
import { Readable } from 'stream';
import WebSocket from 'ws';
import prism from 'prism-media';
import fetch from 'node-fetch';
import * as sherpa_onnx from 'sherpa-onnx';
import { logger } from './logger';

dotenv.config();

// Customisable leave/crash messages
const JOIN_MESSAGE = "On my way to help the boys!";
const SHUTDOWN_MESSAGE = ":wave: Gotta go, I'm shutting down. You got this on your own, sport.";
const CRASH_MESSAGE = ":warning: I'm crashing out! You got this on your own, sport.";

// Validate required environment variables
const requiredEnv = ['DISCORD_TOKEN', 'DEEPGRAM_API_KEY', 'OPENAI_API_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL'];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  console.error(`Missing required environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

// Setup discord client

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const deepgramClient = createDeepgramClient(process.env.DEEPGRAM_API_KEY!);

discordClient.once('ready', () => {
  logger.info('DISCORD', `Logged in as ${discordClient.user?.tag}!`);
});

discordClient.on('guildCreate', (guild) => {
  logger.info('DISCORD', `Joined new server: ${guild.name} (ID: ${guild.id})`);
});

discordClient.on('guildMemberAdd', (member) => {
  logger.info('DISCORD', `User ${member.user.tag} joined server: ${member.guild.name}`);
});

discordClient.on('messageCreate', async (message) => {
  logger.debug('DISCORD', `Message in #${message.channel instanceof TextChannel ? message.channel.name : 'unknown'} by ${message.author.tag}: ${message.content}`);
  if (message.content === '!join' && message.member?.voice.channel) {
    message.reply(JOIN_MESSAGE);

    const channel = message.member.voice.channel;
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator as any,
      selfDeaf: false
    });

    logger.info('DISCORD', `Joined voice channel ${channel.name} in guild ${channel.guild.name}`);

    // Initialize voice listeners for all current non-bot users in the channel
    channel.members.forEach((member) => {
      if (!member.user.bot) {
        const receiver = connection.receiver as VoiceReceiver;
        subscribeAndTranscribe(receiver, member.id, member.voice);
      }
    });
  }

  // Handle !leave command to leave the voice channel
  if (message.content === '!leave') {
    const connection = getVoiceConnection(message.guild!.id);
    if (connection) {
      connection.destroy();
      message.reply('Left the voice channel!');
    } else {
      message.reply('I am not in a voice channel.');
    }
  }
});

discordClient.on('voiceStateUpdate', async (oldState: VoiceState, newState: VoiceState) => {
  logger.debug('DISCORD', `Voice state updated for ${newState.member?.user.tag} in guild ${newState.guild.name}:`);
  // Only listen if user joins a channel and bot is present in that channel
  const botMember = newState.guild.members.me;
  const botChannel = botMember?.voice.channel;
  if (
    newState.channel &&
    botChannel &&
    newState.channel.id === botChannel.id &&
    newState.member?.id !== discordClient.user?.id
  ) {
    const connection = getVoiceConnection(newState.guild.id) as VoiceConnection | undefined;
    if (!connection) {
      console.warn(`No voice connection found for user ${newState.member?.user.tag} in guild ${newState.guild.name}.`);
      return;
    }
    const receiver = connection.receiver as VoiceReceiver;
    subscribeAndTranscribe(receiver, newState.id, newState);
  }

  // Leave if last non-bot user leaves the voice channel
  if (
    oldState.channel &&
    oldState.channel.members.filter(m => !m.user.bot).size === 0
  ) {
    const connection = getVoiceConnection(oldState.guild.id);
    if (connection) {
      connection.destroy();
      logger.info('DISCORD', `Left voice channel ${oldState.channel.name} in guild ${oldState.guild.name} because it was empty.`);
    }
  }

  // Clean up Deepgram stream if user leaves the voice channel
  if (oldState.channel && !newState.channel) {
    cleanupUserInChannel(oldState.channel.id, oldState.id);
    logger.debug('DISCORD', `[voiceStateUpdate] Cleaned up user state for user ${oldState.id} in channel ${oldState.channel.id}`);
  }
});

// Voice channel and user state management
interface UserVoiceState {
  userId: string;
  voiceState: VoiceState;
  deepgramStream?: any;
  // Add more per-user state here as needed
}

interface ChannelVoiceState {
  channelId: string;
  guildId: string;
  users: Map<string, UserVoiceState>;
}

const channelVoiceStates: Map<string, ChannelVoiceState> = new Map(); // key: channelId

function getOrInitChannelState(channelId: string, guildId: string): ChannelVoiceState {
  let state = channelVoiceStates.get(channelId);
  if (!state) {
    state = { channelId, guildId, users: new Map() };
    channelVoiceStates.set(channelId, state);
  }
  return state;
}

function initUserInChannel(channelId: string, guildId: string, userId: string, voiceState: VoiceState): UserVoiceState {
  const channelState = getOrInitChannelState(channelId, guildId);
  let userState = channelState.users.get(userId);
  if (!userState) {
    userState = { userId, voiceState };
    channelState.users.set(userId, userState);
  } else {
    userState.voiceState = voiceState;
  }
  return userState;
}

function cleanupUserInChannel(channelId: string, userId: string) {
  const channelState = channelVoiceStates.get(channelId);
  if (channelState) {
    const userState = channelState.users.get(userId);
    if (userState && userState.deepgramStream) {
      try {
        userState.deepgramStream.disconnect && userState.deepgramStream.disconnect();
        userState.deepgramStream.close && userState.deepgramStream.close();
      } catch (e) {
        console.warn(`[cleanupUserInChannel] Error closing Deepgram stream for user ${userId} in channel ${channelId}:`, e);
      }
    }
    channelState.users.delete(userId);
    if (channelState.users.size === 0) {
      channelVoiceStates.delete(channelId);
    }
  }
}

// Helper to close all Deepgram streams (call on shutdown/leave)
async function closeAllDeepgramStreams() {
  for (const channelState of channelVoiceStates.values()) {
    for (const userState of channelState.users.values()) {
      if (userState.deepgramStream) {
        try {
          userState.deepgramStream.disconnect && userState.deepgramStream.disconnect();
          userState.deepgramStream.close && userState.deepgramStream.close();
        } catch (e) {
          console.warn(`[cleanup] Error closing Deepgram stream for user ${userState.userId} in channel ${channelState.channelId}:`, e);
        }
      }
    }
    channelState.users.clear();
  }
  channelVoiceStates.clear();
}

// Subscribe a user to voice audio transcriptions
function subscribeAndTranscribe(receiver: VoiceReceiver, userId: string, voiceState: VoiceState) {
  // Ensure user/channel state is initialized for future extensibility
  const channelId = voiceState.channelId!;
  const guildId = voiceState.guild.id;
  initUserInChannel(channelId, guildId, userId, voiceState);
  function subscribe() {
    let hasSpoken = false;
    // Subscribe to Opus audio directly (containerized audio)
    const audioStream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 2000
      }
    });
    audioStream.on('data', () => {
      if (!hasSpoken) {
        hasSpoken = true;
        logger.debug('DISCORD', `User ${userId} started speaking in guild ${voiceState.guild.name}`);
      }
    });
    audioStream.on('end', () => {
      if (hasSpoken) {
        hasSpoken = false;
        logger.debug('DISCORD', `User ${userId} stopped speaking in guild ${voiceState.guild.name} (detected silence)`);
      }
      setImmediate(subscribe);
    });
    transcribeUserAudio(audioStream, userId, voiceState);
  }
  subscribe();
}

async function transcribeUserAudio(audioStream: Readable, userId: string, voiceState: VoiceState) {
  logger.debug('DISCORD', `[transcribeUserAudio] Started listening for voice from user ${userId} in guild ${voiceState.guild.name}`);
  // No PCM decoding, send Opus stream directly to Deepgram
  let ws: any = null;
  let wsReady = false;
  let sentChunks = 0;
  let resultReceived = false;
  let closeTimeout: NodeJS.Timeout | null = null;
  ws = deepgramClient.listen.live({
    model: 'nova',
    smart_format: true,
    encoding: 'opus', // Tell Deepgram we're sending Opus
    sample_rate: 48000 // Discord Opus is 48kHz
  });
  setupDeepgramHandlers(ws, userId, voiceState);
  ws.setupConnection && ws.setupConnection();
  logger.debug('STT', `[transcribeUserAudio] Created Deepgram socket for user ${userId} in guild ${voiceState.guild.name}`);
  ws.on('open', () => {
    wsReady = true;
    logger.debug('STT', `[transcribeUserAudio] Deepgram socket opened for user ${userId}`);
    audioStream.on('close', () => {
      logger.debug('DISCORD', `[transcribeUserAudio] audioStream closed for user ${userId} in guild ${voiceState.guild.name}`);
    });
  });
  if (ws.readyState === 1) wsReady = true;
  audioStream.on('data', (chunk) => {
    if (wsReady) {
      ws.send(chunk);
      sentChunks++;
      if (sentChunks === 1) {
        logger.debug('STT', `[transcribeUserAudio] First Opus chunk sent to Deepgram for user ${userId}`);
      }
    } else {
      logger.warn('STT', `[transcribeUserAudio] Deepgram socket not ready for user ${userId}, dropping Opus chunk`);
    }
  });
  audioStream.on('end', () => {
    logger.debug('STT', `[transcribeUserAudio] Opus stream ended for user ${userId} in guild ${voiceState.guild.name}. Sent ${sentChunks} Opus chunks.`);
  });
  audioStream.on('error', (err) => {
    logger.error('STT', `[transcribeUserAudio] Opus stream error for user ${userId}:`, err);
  });
  function tryClose() {
    if (resultReceived && ws) {
      if (closeTimeout) clearTimeout(closeTimeout);
      logger.debug('STT', `[transcribeUserAudio] Closing Deepgram socket for user ${userId} after receiving result.`);
      ws.disconnect && ws.disconnect();
      ws.close && ws.close();
    }
  }
    
  function setupDeepgramHandlers(ws: any, userId: string, voiceState: VoiceState) {
    ws.on('Results', async (data: unknown) => {
      logger.debug('STT', `[transcribeUserAudio] Received Results from Deepgram for user ${userId}:`, JSON.stringify(data));
      try {
        if (typeof data === 'object' && data !== null && 'channel' in data) {
          const channel = (data as any).channel;
          const transcript = channel?.alternatives?.[0]?.transcript;
          if (transcript) {
            resultReceived = true;
            await onUserSpeak(transcript, userId, voiceState);
          }
        }
        tryClose();
      } catch (err) {
        logger.error('STT', `[transcribeUserAudio] Error parsing Deepgram Results for user ${userId}:`, err);
      }
    });
    ws.on('error', (e: unknown) => logger.error('STT', `[transcribeUserAudio] Deepgram socket error for user ${userId}:`, e));
    ws.on('warning', (e: unknown) => logger.warn('STT', `[transcribeUserAudio] Deepgram socket warning for user ${userId}:`, e));
    ws.on('Metadata', (e: unknown) => logger.debug('STT', `[transcribeUserAudio] Deepgram socket metadata for user ${userId}:`, e));
    ws.on('close', (e: unknown) => {
      logger.debug('STT', `[transcribeUserAudio] Deepgram socket closed for user ${userId}:`, e);
    });
  }
}

// Handles what happens when a user says something (transcript received)
async function onUserSpeak(transcript: string, userId: string, voiceState: VoiceState) {
  logger.info('BOT', `[onUserSpeak] Voice message from user ${userId} in guild ${voiceState.guild.name}: ${transcript}`);
  const channelObj = voiceState.guild.channels.cache.get(voiceState.channel!.id);
  if (channelObj && channelObj.isTextBased()) {
    (channelObj as TextChannel).send(`<@${userId}> said: ${transcript}`);
  }

  // If "coach" appears in the first 3 words, use everything after "coach"
  const words = transcript.trim().split(/\s+/);
  const coachIndex = words.findIndex((w) => w.replace(/[^a-z]/gi, '').toLowerCase() === 'coach');
  let openaiInput: string | null = null;

  if (coachIndex !== -1 && coachIndex < 3) {
    logger.debug('BOT', `[onUserSpeak] Found "coach" in first 3 words at index ${coachIndex} in transcript: ${transcript}`);
    openaiInput = words.slice(coachIndex + 1).join(' ').trim();
  } else {
    // Fallback to listening for specifically "hey coach", then take everything after that
    const match = transcript.match(/^\s*hey[, ]+coach[!,. ]+(.*)$/i);
    if (match && match[1]?.trim()) {
      openaiInput = match[1].trim();
      logger.debug('BOT', `[onUserSpeak] Found "hey coach" trigger phrase in transcript, using input: ${match[1].trim()}`);
    }
  }

  if (openaiInput) {
    const openaiReply = await sendTranscriptToOpenAI(openaiInput);
    if (openaiReply && channelObj) {
      (channelObj as TextChannel).send(`<@${userId}> (AI): ${openaiReply}`);
      // Speak the OpenAI reply in the voice channel
      await speakTextInVoiceChannel(openaiReply, voiceState);
    }
  } else {
      logger.debug('BOT', `[onUserSpeak] Trigger phrase not found.`);
  }
}

// Helper to send transcript to OpenAI-compatible API
async function sendTranscriptToOpenAI(transcript: string): Promise<string | null> {
  const apiUrl = process.env.OPENAI_API_URL + '/chat/completions';
  const apiKey = process.env.OPENAI_API_KEY;
  logger.debug('OPENAI', `[sendTranscriptToOpenAI] Called with transcript: ${JSON.stringify(transcript)}`);
  logger.debug('OPENAI', `[sendTranscriptToOpenAI] Using API URL: ${apiUrl}`);
  if (!apiKey) {
    logger.warn('OPENAI', '[sendTranscriptToOpenAI] No OPENAI_API_KEY set, skipping OpenAI call.');
    return null;
  }
  try {
    const payload = {
      model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are a coach for a team playing Age of Empires II. You will be asked strategy questions and you should respond quickly with two or three sentences.' },
        { role: 'user', content: transcript }
      ]
    };
    logger.debug('OPENAI', `[sendTranscriptToOpenAI] Sending payload: ${JSON.stringify(payload)}`);
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });
    logger.debug('OPENAI', `[sendTranscriptToOpenAI] Response status: ${response.status} ${response.statusText}`);
    if (!response.ok) {
      const errorText = await response.text();
      logger.error('OPENAI', `[sendTranscriptToOpenAI] OpenAI API error: ${response.status} ${response.statusText} - ${errorText}`);
      return null;
    }
    const data = await response.json();
    logger.debug('OPENAI', `[sendTranscriptToOpenAI] OpenAI API response: ${JSON.stringify(data)}`);
    const reply = data.choices?.[0]?.message?.content;
    return reply || null;
  } catch (err) {
    logger.error('OPENAI', '[sendTranscriptToOpenAI] Error calling OpenAI API:', err);
    return null;
  }
}

function createTts(){

  let offlineTtsVitsModelConfig = {
      model: 'models/tts/vits-piper-en_GB-alan-medium/en_GB-alan-medium.onnx',
      dataDir: 'models/tts/vits-piper-en_GB-alan-medium/espeak-ng-data',
      tokens: 'models/tts/vits-piper-en_GB-alan-medium/tokens.txt',
      noiseScale: 0.667,
      noiseScaleW: 0.8,
      lengthScale: 1.0,
  };
  let offlineTtsModelConfig = {
    offlineTtsVitsModelConfig: offlineTtsVitsModelConfig,
    numThreads: 1,
    debug: 0,
    provider: 'cpu',
  };
  let offlineTtsConfig = {
    offlineTtsModelConfig: offlineTtsModelConfig,
    maxNumSentences: 1,
  };

  return sherpa_onnx.createOfflineTts(offlineTtsConfig);
}

// sherpa-onnx TTS config (adjust as needed)
const tts = createTts();

// Helper: Speak text in a Discord voice channel using sherpa-onnx TTS
async function speakTextInVoiceChannel(text: string, voiceState: VoiceState) {
  const channel = voiceState.channel;
  if (!channel) {
    logger.warn('DISCORD', '[TTS] No voice channel found for user.');
    return;
  }
  const connection = getVoiceConnection(channel.guild.id) as VoiceConnection | undefined;
  if (!connection) {
    logger.warn('DISCORD', '[TTS] No active voice connection for guild:', channel.guild.id);
    return;
  }

  connection.setSpeaking(true);

  let ffmpeg: any = null;
  let opusStream: any = null;
  let player: any = null;
  try {
    const audio = await tts.generate({
      text,
      sid: 0, // speaker id, if supported by the model
      speed: 1.4,
    });
    // audio.samples: Float32Array, audio.sampleRate: number
    // Convert Float32Array PCM to Buffer (16-bit PCM LE, mono)
    const monoPcmBuffer = Buffer.alloc(audio.samples.length * 2);
    for (let i = 0; i < audio.samples.length; ++i) {
      let s = Math.max(-1, Math.min(1, audio.samples[i]));
      s = s < 0 ? s * 0x8000 : s * 0x7FFF;
      monoPcmBuffer.writeInt16LE(s, i * 2);
    }
    // Convert mono PCM to stereo PCM (duplicate each sample)
    const stereoPcmBuffer = Buffer.alloc(monoPcmBuffer.length * 2);
    for (let i = 0; i < monoPcmBuffer.length; i += 2) {
      monoPcmBuffer.copy(stereoPcmBuffer, i * 2, i, i + 2); // left
      monoPcmBuffer.copy(stereoPcmBuffer, i * 2 + 2, i, i + 2); // right
    }
    const pcmStream = Readable.from(stereoPcmBuffer);
    let inputSampleRate = audio.sampleRate;
    logger.debug('SHERPA', `[TTS] sherpa-onnx output sampleRate: ${inputSampleRate}`);
    let ffmpegArgs = [
      '-f', 's16le',
      '-ar', inputSampleRate.toString(),
      '-ac', '2',
      '-i', 'pipe:0',
      '-ar', '48000',
      '-ac', '2',
      '-f', 's16le', // output format must be right before output
    ];
    ffmpeg = new prism.FFmpeg({ args: ffmpegArgs });
    // Log FFmpeg stderr for debugging
    if (ffmpeg && ffmpeg.process && ffmpeg.process.stderr) {
      ffmpeg.process.stderr.on('data', (chunk: Buffer) => {
        logger.debug('DISCORD', '[TTS] FFmpeg stderr:', chunk.toString());
      });
    }
    ffmpeg.on('error', (err: any) => {
      if (err.code === 'EOF' || (err.message && err.message.includes('write EOF'))) {
        // Ignore write EOF if it happens after stream end
        logger.warn('FFMPEG', '[TTS] FFmpeg stream received write EOF (likely normal for short audio)');
      } else {
        logger.error('FFMPEG', '[TTS] FFmpeg stream error:', err);
      }
    });
    const resampledStream = pcmStream.pipe(ffmpeg);
    opusStream = resampledStream.pipe(new prism.opus.Encoder({
      rate: 48000,
      channels: 2,
      frameSize: 960
    }));
    opusStream.on('error', (err: any) => {
      logger.error('FFMPEG', '[TTS] Opus encoder stream error:', err);
    });
    const resource = createAudioResource(opusStream, { inputType: StreamType.Opus });
    player = createAudioPlayer();
    player.on('error', (err: any) => {
      logger.error('DISCORD', '[TTS] Audio player error:', err);
    });
    connection.subscribe(player);
    player.play(resource);
    player.once(AudioPlayerStatus.Idle, () => {
      player.stop();
      // Clean up streams
      if (opusStream && opusStream.destroy) opusStream.destroy();
      if (ffmpeg && ffmpeg.destroy) ffmpeg.destroy();

    connection.setSpeaking(false);
    logger.info('DISCORD', '[TTS] Finished playing TTS audio for:', voiceState.member?.user.tag);

    });
  } catch (err) {
    logger.error('DISCORD', '[TTS] Error generating or playing TTS:', err);
  }
  // Do not call tts.free() here; only free on shutdown
}

// Gracefully leave all voice channels on shutdown
const cleanup = async (crashMessage?: string) => {
  logger.info('DISCORD', 'Shutting down, leaving all voice channels...');
  await closeAllDeepgramStreams();
  // Leave all voice channels by disconnecting the bot from each guild
  for (const [guildId, connection] of getVoiceConnectionStore() as IterableIterator<[string, VoiceConnection]>) {
    logger.info('DISCORD', `Leaving voice channel for guild ${guildId}`);
    try {
      if(connection.disconnect()) {
        logger.info('DISCORD', `Left voice channel in guild ${guildId}`);
      } else {
        logger.warn('DISCORD', `Failed ot leave voice channel in guild ${guildId}`);
      }
      connection.destroy();    // Ensure resources are cleaned up
    } catch (err) {
      logger.error('DISCORD', `Error leaving voice channel for guild ${guildId}:`, err);
    }
  }
  process.exit(0);
};

process.on('SIGINT', () => cleanup(SHUTDOWN_MESSAGE));
process.on('SIGTERM', () => cleanup(SHUTDOWN_MESSAGE));

// Handle uncaught exceptions and unhandled rejections to ensure cleanup
process.on('uncaughtException', async (err) => {
  logger.error('DISCORD', 'Uncaught Exception:', err);
  await cleanup(CRASH_MESSAGE);
  process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
  logger.error('DISCORD', 'Unhandled Rejection at:', promise, 'reason:', reason);
  await cleanup(CRASH_MESSAGE);
  process.exit(1);
});

// Helper to get all active voice connections
function getVoiceConnectionStore(): IterableIterator<[string, VoiceConnection]> {
  return getVoiceConnections().entries();
}

discordClient.login(process.env.DISCORD_TOKEN);
