// Подключается через `node --import ./tests/register.mjs`.
import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
