declare module 'sherpa-onnx' {
  export class OfflineTts {
    constructor(config: any);
    generate(options: { text: string; sid?: number; speed?: number }): Promise<{ samples: Float32Array; sampleRate: number }>;
    free(): void;
  }
}
