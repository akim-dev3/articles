const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

function buildPrompt(criteria, targetN, items) {
  return `Ты — ассистент-исследователь, который помогает провести отбор научных статей по заданным критериям (как на этапе title/abstract screening в систематическом обзоре литературы).

Критерии отбора, сформулированные исследователем:
"""
${criteria}
"""

Всего из большого массива нужно в итоге отобрать примерно ${targetN} наиболее релевантных статей. Сейчас оцени независимо каждую статью из списка ниже.

Для каждой статьи прими решение:
- "include" — статья явно соответствует критериям включения;
- "exclude" — статья явно не подходит или подпадает под критерии исключения;
- "maybe" — по доступной информации (часто это только название, без аннотации) невозможно однозначно решить, нужна проверка человеком.

Дай также оценку релевантности score (целое число от 0 до 100, где 0 — совсем не подходит, 100 — идеально подходит) и очень краткое обоснование reason на русском языке (одно предложение).

Список статей в формате JSON (id, title, code, abstract — поле abstract может отсутствовать или быть пустым):
${JSON.stringify(items)}

Ответь СТРОГО одним JSON-объектом без markdown и без пояснений вокруг, в виде:
{"results": [{"id": <id>, "decision": "include|maybe|exclude", "score": <0-100>, "reason": "<кратко по-русски>"}, ...]}
В массиве results должен быть ровно один объект на каждую статью из списка, с сохранением исходных id.`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractJson(text) {
  const trimmed = text.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to bracket extraction
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // fall through
    }
  }
  throw new Error('Не удалось разобрать ответ модели как JSON: ' + text.slice(0, 200));
}

async function callOnce(apiKey, model, prompt, useJsonMode) {
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 4096
  };
  if (useJsonMode) body.response_format = { type: 'json_object' };

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': location.href,
      'X-Title': 'Article Screener'
    },
    body: JSON.stringify(body)
  });
  return res;
}

export async function screenBatch({ apiKey, model, criteria, targetN, articles }) {
  const items = articles.map((a) => {
    const item = { id: a.id, title: a.title, code: a.code };
    if (a.abstract) item.abstract = a.abstract.slice(0, 2500);
    return item;
  });
  const prompt = buildPrompt(criteria, targetN, items);

  const maxRetries = 5;
  let attempt = 0;
  let delay = 2000;
  let useJsonMode = true;

  while (true) {
    attempt++;
    let res;
    try {
      res = await callOnce(apiKey, model, prompt, useJsonMode);
    } catch (networkErr) {
      if (attempt > maxRetries) throw new Error('Сетевая ошибка при обращении к OpenRouter: ' + networkErr.message);
      await sleep(delay);
      delay = Math.min(delay * 2, 60000);
      continue;
    }

    if (res.status === 400 && useJsonMode) {
      // Some free models don't support response_format — retry once without it.
      useJsonMode = false;
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      if (attempt > maxRetries) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`Превышен лимит попыток (HTTP ${res.status}): ${errBody.slice(0, 200)}`);
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 60000);
      continue;
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      let msg = errBody;
      try {
        msg = JSON.parse(errBody).error?.message || errBody;
      } catch {
        // keep raw text
      }
      throw new Error(`Ошибка API OpenRouter (HTTP ${res.status}): ${String(msg).slice(0, 300)}`);
    }

    const data = await res.json();
    if (data.error) {
      throw new Error('Ошибка модели: ' + (data.error.message || JSON.stringify(data.error)).slice(0, 300));
    }
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('Пустой ответ модели (возможно, эта бесплатная модель сейчас перегружена — попробуйте другую в настройках)');
    }

    const parsed = extractJson(content);
    const results = Array.isArray(parsed) ? parsed : parsed.results;
    if (!Array.isArray(results)) throw new Error('Ответ модели не содержит массив results');
    return results;
  }
}
