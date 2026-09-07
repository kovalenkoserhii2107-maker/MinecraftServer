export const FormCancelationReason = { UserBusy: 'UserBusy', UserClosed: 'UserClosed' };

/** Показанные формы — тесты сверяют по ним заголовки и кнопки. */
export const __shown = [];

/**
 * Очередь ответов игрока. Каждый показ формы забирает следующий элемент:
 * число — индекс нажатой кнопки, undefined — игрок закрыл форму.
 * Это позволяет прогонять навигацию по меню, а не только факт показа.
 */
let __responses = [];
export function __queueResponses(list) { __responses = [...list]; }
export function __reset() { __shown.length = 0; __responses = []; }

export class ActionFormData {
  constructor(){ this.buttons = []; }
  title(t){ this._title = t; return this; }
  body(b){ this._body = b; return this; }
  button(t){ this.buttons.push(t); return this; }
  async show(player){
    __shown.push({ player: player.name, title: this._title, body: this._body, buttons: [...this.buttons] });
    const selection = __responses.shift();
    return selection === undefined
      ? { canceled: true, cancelationReason: FormCancelationReason.UserClosed, selection: undefined }
      : { canceled: false, cancelationReason: undefined, selection };
  }
}
