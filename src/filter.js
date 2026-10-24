export function filterOpenRouterModels(modelList) {
  if (!Array.isArray(modelList)) return [];

  return modelList.filter((m) => {
    if (!m || typeof m !== 'string') return false;

    // 1. Cut all batch models
    if (m.includes(':batch') || m.includes('batch')) {
      return false;
    }

    const lower = m.toLowerCase();

    // 2. gemini до 3.5 (отрезать < 3.5 и nano)
    if (lower.includes('gemini')) {
      const match = lower.match(/gemini-(\d+(?:\.\d+)?)/);
      if (match && parseFloat(match[1]) < 3.5) return false;
      if (lower.includes('gemini-nano')) return false;
    }

    // 3. gpt до 5.6 (отрезать < 5.6, а также legacy gpt-4, gpt-3, gpt-audio, gpt-chat, gpt-oss)
    if (/\bgpt-/.test(lower)) {
      const match = lower.match(/gpt-(\d+(?:\.\d+)?)/);
      if (match && parseFloat(match[1]) < 5.6) return false;
      if (['gpt-audio', 'gpt-chat', 'gpt-oss', 'gpt-4o', 'gpt-4'].some(k => lower.includes(k))) return false;
    }

    // 4. qwen до 3.8 (отрезать < 3.8, а также qwen-plus, qwen-2.5, qwen3-)
    if (lower.includes('qwen')) {
      const match = lower.match(/qwen(\d+(?:\.\d+)?)/);
      if (match && parseFloat(match[1]) < 3.8) return false;
      if (['qwen-plus', 'qwen-2.5', 'qwen3-'].some(k => lower.includes(k))) return false;
    }

    // 5. glm до 5.2 (отрезать < 5.2, а также glm-5v, glm-5-turbo, glm-4)
    if (lower.includes('glm')) {
      const match = lower.match(/glm-(\d+(?:\.\d+)?)/);
      if (match && parseFloat(match[1]) < 5.2) return false;
      if (['glm-5v', 'glm-5-turbo', 'glm-4'].some(k => lower.includes(k))) return false;
    }

    // 6. claude до 5 (отрезать < 5.0)
    if (lower.includes('claude')) {
      const match = lower.match(/claude-(?:haiku-|sonnet-|opus-|fable-)?(\d+(?:\.\d+)?)/);
      if (match && parseFloat(match[1]) < 5.0) return false;
    }

    // 7. deepseek до 4 (отрезать < 4.0, а также deepseek-chat, deepseek-r1)
    if (lower.includes('deepseek')) {
      const match = lower.match(/deepseek-v?(\d+(?:\.\d+)?)/);
      if (match && parseFloat(match[1]) < 4.0) return false;
      if (['deepseek-chat', 'deepseek-r1'].some(k => lower.includes(k))) return false;
    }

    // 8. mimo до 2.6 (отрезать < 2.6)
    if (lower.includes('mimo')) {
      const match = lower.match(/mimo-v?(\d+(?:\.\d+)?)/);
      if (match && parseFloat(match[1]) < 2.6) return false;
    }

    return true;
  });
}
