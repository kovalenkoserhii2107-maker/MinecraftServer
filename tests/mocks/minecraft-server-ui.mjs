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

/**
 * Очередь ответов на модальные формы: массив значений полей или undefined,
 * если игрок закрыл форму.
 */
let __modalResponses = [];
export function __queueModalResponses(list) { __modalResponses = [...list]; }

export function __reset() { __shown.length = 0; __responses = []; __modalResponses = []; }

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

/** Модальная форма: поля объявляются, значения приходят из очереди тестов. */
export class ModalFormData {
  constructor(){ this.fields = []; }
  title(t){ this._title = t; return this; }
  label(t){ this.fields.push({ kind: 'label', text: t }); return this; }
  divider(){ this.fields.push({ kind: 'divider' }); return this; }
  header(t){ this.fields.push({ kind: 'header', text: t }); return this; }
  textField(label, placeholder, options){ this.fields.push({ kind: 'textField', label, placeholder, options }); return this; }
  toggle(label, options){ this.fields.push({ kind: 'toggle', label, options }); return this; }
  slider(label, min, max, options){ this.fields.push({ kind: 'slider', label, min, max, options }); return this; }
  dropdown(label, items, options){ this.fields.push({ kind: 'dropdown', label, items, options }); return this; }
  submitButton(text){ this._submit = text; return this; }
  async show(player){
    __shown.push({ player: player.name, title: this._title, modal: true, fields: [...this.fields] });
    const values = __modalResponses.shift();
    return values === undefined
      ? { canceled: true, cancelationReason: FormCancelationReason.UserClosed, formValues: undefined }
      : { canceled: false, cancelationReason: undefined, formValues: values };
  }
}
