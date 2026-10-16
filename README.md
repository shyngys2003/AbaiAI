# Abai AI на Vercel

public/index.html  - сайт
api/chat.js        - прокси к Gemini (ключ только на сервере)
api/sync.js        - сохранение прогресса в Redis
lib/               - общий код

Переменные окружения (Vercel -> Settings -> Environment Variables):
  GEMINI_KEY   ключ из aistudio.google.com/apikey
Redis: Vercel -> Storage -> Upstash Redis (Marketplace) -> Connect to project (переменные добавятся сами).
