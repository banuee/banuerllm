# banuerllm

Единый OpenAI-совместимый прокси-шлюз и хранилище API-ключей от нейросетей. Позволяет объединить любое количество провайдеров (OpenAI, DeepSeek, Groq, OpenRouter, Mistral, локальная Ollama) под единым адресом и собственным набором виртуальных ключей.

## Возможности

- **OpenAI-совместимость:** прозрачный прокси для `/v1/chat/completions` (с полной поддержкой SSE-стриминга) и `/v1/models`.
- **Автоматическая маршрутизация:** распределение запросов по моделям и приоритетам провайдеров.
- **Встроенная панель управления:** добавление и редактирование провайдеров, автозагрузка доступных моделей с удаленного эндпоинта, генерация виртуальных ключей, просмотр журнала запросов в реальном времени.
- **Zero-dependency архитектура:** работает нативно на Node.js (>=22) со встроенным `node:sqlite`, быстрым асинхронным HTTP-клиентом и нативными веб-потоками. Занимает ~25 МБ RAM.
- **Встроенный Keep-Alive для Render:** регулярный фоновый самопинг предотвращает засыпание бесплатного инстанса.

---

## Быстрый запуск локально

```bash
cd ~/Проекты/banuerllm

# Запуск сервера на порту 3000
npm start

# Или в режиме разработки с автоперезагрузкой при изменении файлов:
npm run dev
```

При первом запуске сервер выведет в терминал сгенерированный мастер-ключ администрирования:
```text
========================================
🚀 banuerllm running on http://0.0.0.0:3000
🔑 Master Admin Key: banue-admin-xxxxxxxxxxxx
========================================
```

Откройте в браузере: `http://localhost:3000` и введите мастер-ключ.

---

## Деплой на Render (Бесплатный тариф)

1. Создайте репозиторий на GitHub и отправьте туда проект:
   ```bash
   cd ~/Проекты/banuerllm
   git add .
   git commit -m "Initial commit"
   git remote add origin git@github.com:<ваш_логин>/banuerllm.git
   git push -u origin master
   ```

2. Зайдите в [Render Dashboard](https://dashboard.render.com/) -> **New +** -> **Web Service**.
3. Подключите ваш GitHub репозиторий.
4. Настройки сервиса:
   * **Runtime:** Node
   * **Build Command:** *(оставьте пустым)*
   * **Start Command:** `node src/server.js`
   * **Instance Type:** Free
5. В разделе **Environment Variables** добавьте:
   * `NODE_ENV` = `production`
   * `ADMIN_KEY` = `<любой_придуманный_вами_стойкий_пароль>`
6. Нажмите **Deploy Web Service**.

---

## Как не давать серверу засыпать на Render

Бесплатный тариф Render усыпляет контейнер при отсутствии входящего трафика в течение 15 минут. Чтобы сервис работал непрерывно:

### Способ 1: Встроенный Keep-Alive
1. Скопируйте полученный адрес сервиса на Render (например, `https://banuerllm.onrender.com`).
2. Откройте панель управления `banuerllm` в браузере -> вкладка **Параметры**.
3. В поле **Render Keep-Alive** вставьте `https://banuerllm.onrender.com/ping` и нажмите **Сохранить**.
4. Сервер будет каждые 12 минут отправлять легкий HTTP-запрос на собственный эндпоинт `/ping`.

### Способ 2: Внешний бесплатный монитор (рекомендуется как самый надежный)
Зарегистрируйтесь на бесплатном сервисе [cron-job.org](https://cron-job.org) или [UptimeRobot](https://uptimerobot.com) и настройте регулярный GET-запрос каждые 10 минут на адрес:
`https://<ваш-сервис>.onrender.com/ping`

---

## Подключение клиентов к вашему шлюзу

### Базовые параметры
* **Base URL:** `https://<ваш-сервис>.onrender.com/v1`
* **API Key:** созданный во вкладке «Ключи» виртуальный ключ вида `sk-banue-...` (или ваш мастер-ключ).

### Python (OpenAI SDK)
```python
from openai import OpenAI

client = OpenAI(
    base_url="https://<ваш-сервис>.onrender.com/v1",
    api_key="sk-banue-..."
)

response = client.chat.completions.create(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "Привет, расскажи о проекте."}],
    stream=True
)

for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
print()
```

### cURL
```bash
curl https://<ваш-сервис>.onrender.com/v1/chat/completions \
  -H "Authorization: Bearer sk-banue-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "Тестовый запрос"}],
    "stream": false
  }'
```

### Подключение в Cursor / Roo Code / Cline
1. Откройте настройки расширения / модели в вашей IDE.
2. Выберите провайдер **OpenAI Compatible**.
3. Введите:
   * **Base URL:** `https://<ваш-сервис>.onrender.com/v1`
   * **API Key:** `sk-banue-...`
   * **Model ID:** название любой модели, привязанной к вашим провайдерам в `banuerllm`.

---

## Структура проекта

```text
banuerllm/
├── src/
│   ├── db.js          # SQLite база (WAL-режим, хранение провайдеров, ключей, логов)
│   ├── proxy.js       # Маршрутизатор моделей, проверка токенов, SSE-стриминг
│   └── server.js      # HTTP-сервер, REST API админки, раздача статики, keep-alive
├── public/
│   ├── index.html     # Интерфейс управления
│   ├── tokens.css     # Дизайн-токены (палитра Lumen)
│   ├── base.css       # Базовые стили и нормализация
│   ├── style.css      # Стили панели управления
│   └── app.js         # Клиентская логика SPA
├── Dockerfile         # Готовый контейнер для любого облака
├── render.yaml        # Манифест для деплоя в Render в один клик
└── package.json
```
