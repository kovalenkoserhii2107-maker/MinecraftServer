export const FormCancelationReason = { UserBusy: 'UserBusy', UserClosed: 'UserClosed' };
export const __shown = [];
/** Форма всегда «закрыта игроком»: проверяем только, что показ не падает. */
export class ActionFormData {
  constructor(){ this.buttons = []; }
  title(t){ this._title = t; return this; }
  body(b){ this._body = b; return this; }
  button(t){ this.buttons.push(t); return this; }
  async show(player){
    __shown.push({ player: player.name, title: this._title, body: this._body, buttons: [...this.buttons] });
    return { canceled: true, cancelationReason: FormCancelationReason.UserClosed, selection: undefined };
  }
}
