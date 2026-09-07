/**
 * Минимальные объявления среды исполнения Bedrock Script API (QuickJS).
 *
 * В движке НЕТ Node.js: недоступны `fs`, `path`, `http`, `process`, `Buffer`,
 * `setTimeout`/`setInterval`. Для планирования используйте `system.runInterval`
 * и `system.runTimeout` из `@minecraft/server`.
 *
 * `console` движком предоставляется и выводится в лог контейнера
 * (`docker logs -f bds`), поэтому объявляем только его.
 */
declare const console: {
    log(...data: unknown[]): void;
    info(...data: unknown[]): void;
    warn(...data: unknown[]): void;
    error(...data: unknown[]): void;
};
