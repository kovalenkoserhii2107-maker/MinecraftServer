/**
 * Резолвер модулей для тестов: подменяет `@minecraft/server` и
 * `@minecraft/server-ui` моками.
 *
 * Подмена делается хуком загрузчика, а не файлами в node_modules: настоящие
 * пакеты нужны компилятору для типов, и подменять их на диске нельзя.
 */
const MOCKS = new Map([
    ['@minecraft/server', new URL('./mocks/minecraft-server.mjs', import.meta.url).href],
    ['@minecraft/server-ui', new URL('./mocks/minecraft-server-ui.mjs', import.meta.url).href],
]);

export async function resolve(specifier, context, nextResolve) {
    const mock = MOCKS.get(specifier);
    if (mock) return { url: mock, shortCircuit: true };
    return nextResolve(specifier, context);
}
