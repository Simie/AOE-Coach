# AOE-Coach Discord Bot

This is a Node.js TypeScript Discord bot that can connect to a voice channel and respond to voice commands using speech-to-text (Deepgram SDK).

## Features
- Connects to Discord voice channels
- Listens for user speech and transcribes it
- Feeds user speech into an OpenAI compatible API endpoint
- Uses sherpa-onnx TTS to read out the response into the voice channel.

## Setup
1. Install dependencies:
   ```sh
   npm install
   ```
2. Create a `.env` file with your Discord bot token and Deepgram API key:
   ```env
   DISCORD_TOKEN=your_discord_token
   DEEPGRAM_API_KEY=your_deepgram_api_key
   ```
3. Build and run the bot:
   ```sh
   npx ts-node src/bot.ts
   ```

## Development
- TypeScript configuration is in `tsconfig.json`.
- Main bot code is in `src/bot.ts`.

## License
MIT
