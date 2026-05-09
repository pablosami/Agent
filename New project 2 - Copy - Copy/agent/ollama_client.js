const axios = require('axios');
const config = require('./config');

async function generate(prompt, options = {}) {
  const url = `${config.ollamaHost.replace(/\/$/, '')}/api/generate`;
  try {
    const response = await axios.post(
      url,
      {
        model: options.model || config.modelName,
        prompt,
        stream: false,
        options: {
          num_predict: options.numPredict || config.maxTokens
        }
      },
      { timeout: config.requestTimeoutMs }
    );

    if (!response.data || typeof response.data.response !== 'string') {
      throw new Error('Ollama returned an unexpected response shape.');
    }
    return response.data.response;
  } catch (error) {
    const detail = error.response?.data?.error || error.message;
    throw new Error(`Ollama request failed: ${detail}`);
  }
}

module.exports = {
  generate
};
