// 能力标注。
// 现实问题：OpenAI 的 /v1/models 只返回 id，几乎没有厂商在里面给出模态信息。
// 所以这里按模型名做启发式猜测，猜完之后面板里可以逐项手工改 —— 手工值优先。

export const CAP_KEYS = ['text', 'vision', 'audio', 'video', 'tools', 'json', 'reasoning'];

const has = (s, ...words) => words.some((w) => s.includes(w));

export function guessModelMeta(rawId, providerType = '') {
  const id = String(rawId || '').toLowerCase();

  const isEmbedding = has(id, 'embed', 'bge-', 'gte-', 'text-embedding', 'nv-embed', 'm3e');
  const isRerank = has(id, 'rerank', 'reranker');
  const isImageGen = has(id, 'dall-e', 'image-generation', 'flux', 'stable-diffusion', 'sdxl', 'kolors', 'wanx', 'seedream', 'imagen');
  const isTTS = has(id, 'tts', 'speech', 'voice', 'cosyvoice', 'sambert');
  const isASR = has(id, 'whisper', 'asr', 'paraformer', 'sensevoice');
  const isVideoGen = has(id, 'veo', 'sora', 'kling', 'wanx-video', 'seedance');

  let kind = 'chat';
  if (isEmbedding) kind = 'embedding';
  else if (isRerank) kind = 'rerank';
  else if (isImageGen) kind = 'image';
  else if (isVideoGen) kind = 'video';
  else if (isTTS || isASR) kind = 'audio';

  const vision =
    has(id, 'vl', 'vision', 'omni', 'multimodal', 'llava', 'pixtral', 'internvl', 'minicpm-v', 'glm-4v', 'gemini', 'claude-3', 'claude-4', 'claude-opus', 'claude-sonnet', 'gpt-4o', 'gpt-4.1', 'gpt-5', 'gpt-6', 'nemotron-vl', 'qvq', 'step-1v', 'mimo-v2.5') &&
    kind === 'chat';

  const audio = (has(id, 'omni', 'audio', 'realtime') || isTTS || isASR) && kind !== 'embedding';
  const video = has(id, 'video', 'veo', 'sora', 'omni-video') || isVideoGen;

  const reasoning = has(id, '-r1', 'r1-', 'reasoner', 'thinking', 'think', 'qwq', 'qvq', 'o1', 'o3', 'o4-mini', 'reason', 'deep-think');

  // 绝大多数 instruct/chat 模型都支持 function calling；base、embedding、语音类不支持。
  const tools = kind === 'chat' && !has(id, '-base', 'base-', 'instruct-base');

  return {
    kind,
    caps: {
      text: kind === 'chat',
      vision,
      audio,
      video,
      tools,
      json: kind === 'chat',
      reasoning,
    },
  };
}

export function normalizeCaps(caps) {
  const out = {};
  for (const k of CAP_KEYS) out[k] = Boolean(caps && caps[k]);
  return out;
}
