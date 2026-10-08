# web

Интерфейс на React и Vite. Браузер обращается только к относительному пути `/api`. Vite проксирует его на gateway: на хосте это `http://localhost:3000`, в Docker — `http://api-gateway:3000`.
