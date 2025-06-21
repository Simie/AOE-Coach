import { Client, GatewayIntentBits, VoiceState, TextChannel } from 'discord.js';
import {
  joinVoiceChannel,
  EndBehaviorType,
  getVoiceConnection,
  VoiceConnection,
  VoiceReceiver
} from '@discordjs/voice';
import { createClient as createDeepgramClient } from '@deepgram/sdk';
import * as dotenv from 'dotenv';
import { Readable } from 'stream';
import WebSocket from 'ws';
import prism from 'prism-media';
import fetch from 'node-fetch';

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
  console.log(`Logged in as ${discordClient.user?.tag}!`);
});

discordClient.on('guildCreate', (guild) => {
  console.log(`Joined new server: ${guild.name} (ID: ${guild.id})`);
});

discordClient.on('guildMemberAdd', (member) => {
  console.log(`User ${member.user.tag} joined server: ${member.guild.name}`);
});

discordClient.on('messageCreate', async (message) => {
  console.log(`Message in #${message.channel instanceof TextChannel ? message.channel.name : 'unknown'} by ${message.author.tag}: ${message.content}`);
  if (message.content === '!join' && message.member?.voice.channel) {
    message.reply(JOIN_MESSAGE);

    const channel = message.member.voice.channel;
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator as any,
      selfDeaf: false
    });

    // Initialize voice listeners for all current non-bot users in the channel
    channel.members.forEach((member) => {
      if (!member.user.bot) {
        const receiver = connection.receiver as VoiceReceiver;
        subscribeAndTranscribe(receiver, member.id, member.voice);
      }
    });
  }
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
  console.log(`Voice state updated for ${newState.member?.user.tag} in guild ${newState.guild.name}:`);
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
      console.log(`Left voice channel ${oldState.channel.name} in guild ${oldState.guild.name} because it was empty.`);
    }
  }

  // Clean up Deepgram stream if user leaves the voice channel
  if (oldState.channel && !newState.channel) {
    cleanupUserInChannel(oldState.channel.id, oldState.id);
    console.log(`[voiceStateUpdate] Cleaned up user state for user ${oldState.id} in channel ${oldState.channel.id}`);
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
        console.log(`User ${userId} started speaking in guild ${voiceState.guild.name}`);
      }
    });
    audioStream.on('end', () => {
      if (hasSpoken) {
        hasSpoken = false;
        console.log(`User ${userId} stopped speaking in guild ${voiceState.guild.name} (detected silence)`);
      }
      setImmediate(subscribe);
    });
    transcribeUserAudio(audioStream, userId, voiceState);
  }
  subscribe();
}

async function transcribeUserAudio(audioStream: Readable, userId: string, voiceState: VoiceState) {
  console.log(`[transcribeUserAudio] Started listening for voice from user ${userId} in guild ${voiceState.guild.name}`);
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
  console.log(`[transcribeUserAudio] Created Deepgram socket for user ${userId} in guild ${voiceState.guild.name}`);
  ws.on('open', () => {
    wsReady = true;
    console.log(`[transcribeUserAudio] Deepgram socket opened for user ${userId}`);
    audioStream.on('close', () => {
      console.log(`[transcribeUserAudio] audioStream closed for user ${userId} in guild ${voiceState.guild.name}`);
    });
  });
  if (ws.readyState === 1) wsReady = true;
  audioStream.on('data', (chunk) => {
    if (wsReady) {
      ws.send(chunk);
      sentChunks++;
      if (sentChunks === 1) {
        console.log(`[transcribeUserAudio] First Opus chunk sent to Deepgram for user ${userId}`);
      }
    } else {
      console.warn(`[transcribeUserAudio] Deepgram socket not ready for user ${userId}, dropping Opus chunk`);
    }
  });
  audioStream.on('end', () => {
    console.log(`[transcribeUserAudio] Opus stream ended for user ${userId} in guild ${voiceState.guild.name}. Sent ${sentChunks} Opus chunks.`);
  });
  audioStream.on('error', (err) => {
    console.error(`[transcribeUserAudio] Opus stream error for user ${userId}:`, err);
  });
  function tryClose() {
    if (resultReceived && ws) {
      if (closeTimeout) clearTimeout(closeTimeout);
      console.log(`[transcribeUserAudio] Closing Deepgram socket for user ${userId} after receiving result.`);
      ws.disconnect && ws.disconnect();
      ws.close && ws.close();
    }
  }
  function setupDeepgramHandlers(ws: any, userId: string, voiceState: VoiceState) {
    ws.on('Results', async (data: unknown) => {
      console.log(`[transcribeUserAudio] Received Results from Deepgram for user ${userId}:`, JSON.stringify(data));
      try {
        if (typeof data === 'object' && data !== null && 'channel' in data) {
          const channel = (data as any).channel;
          const transcript = channel?.alternatives?.[0]?.transcript;
          if (transcript) {
            resultReceived = true;
            console.log(`[transcribeUserAudio] Voice message from user ${userId} in guild ${voiceState.guild.name}: ${transcript}`);
            const channelObj = voiceState.guild.channels.cache.get(voiceState.channel!.id);
            if (channelObj && channelObj.isTextBased()) {
              (channelObj as TextChannel).send(`<@${userId}> said: ${transcript}`);
            }
            // Send transcript to OpenAI and reply with the response
            const openaiReply = await sendTranscriptToOpenAI(transcript);
            if (openaiReply && channelObj) {
              (channelObj as TextChannel).send(`<@${userId}> (AI): ${openaiReply}`);
            }
          }
        }
        tryClose();
      } catch (err) {
        console.error(`[transcribeUserAudio] Error parsing Deepgram Results for user ${userId}:`, err);
      }
    });
    ws.on('error', (e: unknown) => console.error(`[transcribeUserAudio] Deepgram socket error for user ${userId}:`, e));
    ws.on('warning', (e: unknown) => console.warn(`[transcribeUserAudio] Deepgram socket warning for user ${userId}:`, e));
    ws.on('Metadata', (e: unknown) => console.log(`[transcribeUserAudio] Deepgram socket metadata for user ${userId}:`, e));
    ws.on('close', (e: unknown) => {
      console.log(`[transcribeUserAudio] Deepgram socket closed for user ${userId}:`, e);
    });
  }
}

// Helper to send transcript to OpenAI-compatible API
async function sendTranscriptToOpenAI(transcript: string): Promise<string | null> {
  const apiUrl = process.env.OPENAI_API_URL + '/chat/completions';
  const apiKey = process.env.OPENAI_API_KEY;
  console.log(`[sendTranscriptToOpenAI] Called with transcript: ${JSON.stringify(transcript)}`);
  console.log(`[sendTranscriptToOpenAI] Using API URL: ${apiUrl}`);
  if (!apiKey) {
    console.warn('[sendTranscriptToOpenAI] No OPENAI_API_KEY set, skipping OpenAI call.');
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
    console.log(`[sendTranscriptToOpenAI] Sending payload: ${JSON.stringify(payload)}`);
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });
    console.log(`[sendTranscriptToOpenAI] Response status: ${response.status} ${response.statusText}`);
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[sendTranscriptToOpenAI] OpenAI API error: ${response.status} ${response.statusText} - ${errorText}`);
      return null;
    }
    const data = await response.json();
    console.log(`[sendTranscriptToOpenAI] OpenAI API response: ${JSON.stringify(data)}`);
    const reply = data.choices?.[0]?.message?.content;
    return reply || null;
  } catch (err) {
    console.error('[sendTranscriptToOpenAI] Error calling OpenAI API:', err);
    return null;
  }
}

// Gracefully leave all voice channels on shutdown
const cleanup = async (crashMessage?: string) => {
  console.log('Shutting down, leaving all voice channels...');
  await closeAllDeepgramStreams();
  // Leave all voice channels by disconnecting the bot from each guild
  for (const [guildId, connection] of getVoiceConnectionStore() as IterableIterator<[string, VoiceConnection]>) {
    console.log(`Leaving voice channel for guild ${guildId}`);
    try {
      // Attempt to send a message to the text channel associated with the voice channel
      const guild = discordClient.guilds.cache.get(guildId);
      if (guild) {
        const botMember = guild.members.me;
        if (botMember && botMember.voice.channel) {
          if(crashMessage) {
            botMember.voice.channel.send(crashMessage);
          }
          console.log(`Left voice channel in guild ${guild.name}`);
        }
      }
      connection.disconnect(); // Disconnect from the voice channel
      connection.destroy();    // Ensure resources are cleaned up
    } catch (err) {
      console.error(`Error leaving voice channel for guild ${guildId}:`, err);
    }
  }
  process.exit(0);
};

process.on('SIGINT', () => cleanup(SHUTDOWN_MESSAGE));
process.on('SIGTERM', () => cleanup(SHUTDOWN_MESSAGE));

// Handle uncaught exceptions and unhandled rejections to ensure cleanup
process.on('uncaughtException', async (err) => {
  console.error('Uncaught Exception:', err);
  await cleanup(CRASH_MESSAGE);
  process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  await cleanup(CRASH_MESSAGE);
  process.exit(1);
});

// Helper to get all active voice connections
function getVoiceConnectionStore(): IterableIterator<[string, VoiceConnection]> {
  // @discordjs/voice v0.8+ stores connections in a Map
  // @ts-ignore
  return require('@discordjs/voice').getVoiceConnections().entries();
}

discordClient.login(process.env.DISCORD_TOKEN);
