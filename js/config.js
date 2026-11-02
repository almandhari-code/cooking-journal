/** AI model ids in ONE place. If the AI service retires a model, change it here (list: GET /openai/v1/models). */
export const TEXT_MODELS=['openai/gpt-oss-120b','qwen/qwen3.8-27b']; // tried in order
export const WHISPER_MODEL='whisper-large-v3-turbo';
export const VISION_MODEL='qwen/qwen3.8-27b'; // must accept images (at least 32px per side)
export const MODEL_GONE_MSG='AI model unavailable, update config (js/config.js).';
