import { invoke } from "@tauri-apps/api/core";

/** Speech/text providers the app can be connected to. Keys are stored by Rust (see api_keys.rs). */
export type KeyProviderId = "openai" | "google" | "anthropic" | "elevenlabs";

export interface KeyProvider {
  id: KeyProviderId;
  label: string;
  /** What the key will be used for once the engine is connected. */
  purpose: string;
}

export const KEY_PROVIDERS: KeyProvider[] = [
  { id: "google", label: "Google (Gemini)", purpose: "Transcription with gemini-3.5-transcribe (supports a custom vocabulary of names)." },
  { id: "openai", label: "OpenAI", purpose: "Transcription with whisper-1 (word timestamps) or gpt-transcribe." },
  { id: "anthropic", label: "Anthropic (Claude)", purpose: "Proofreading of caption text (names, punctuation) — Claude cannot transcribe audio." },
  { id: "elevenlabs", label: "ElevenLabs", purpose: "Scribe speech-to-text and voice-over timing." },
];

export type EngineId = "local-whisper" | "gemini" | "openai-whisper" | "elevenlabs-scribe";

export interface TranscriptionEngine {
  id: EngineId;
  label: string;
  /** Key provider required, or null for fully local engines. */
  needsKey: KeyProviderId | null;
  /** False until the provider call is implemented; the key can already be saved. */
  implemented: boolean;
}

export const ENGINES: TranscriptionEngine[] = [
  { id: "local-whisper", label: "Local Whisper (offline, free)", needsKey: null, implemented: true },
  { id: "gemini", label: "Google Gemini 3.5 Transcribe", needsKey: "google", implemented: false },
  { id: "openai-whisper", label: "OpenAI Whisper API", needsKey: "openai", implemented: false },
  { id: "elevenlabs-scribe", label: "ElevenLabs Scribe", needsKey: "elevenlabs", implemented: false },
];

export const listSavedKeyProviders = (): Promise<KeyProviderId[]> => invoke<KeyProviderId[]>("list_api_key_providers");
export const saveApiKey = (provider: KeyProviderId, key: string): Promise<void> => invoke("set_api_key", { provider, key });
export const removeApiKey = (provider: KeyProviderId): Promise<void> => invoke("delete_api_key", { provider });
