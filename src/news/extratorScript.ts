/**
 * Roteiro injetado no navegador escondido (Android WebView) para baixar Reels
 * pelos sites tipo SnapInsta (fastdl, igram, sssinstagram): cola o link, manda
 * e espera o botão "Download" aparecer. Devolve o link do arquivo por
 * window.PNExtrator.done(link) (ou .fail(motivo)).
 */
export const EXTRATOR_SITES = ['https://fastdl.app/', 'https://sssinstagram.com/', 'https://igram.world/'];

export function extratorScript(reel: string): string {
  return `(function(){
  if (window.__pnRodando) return; window.__pnRodando = true;
  var REEL = ${JSON.stringify(reel)};
  var fim = Date.now() + 45000, enviado = false;
  function achaInput(){ return document.querySelector('#search-form-input, #input, input[type=text][name=url], input[type=url]'); }
  function envia(inp){
    var set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(inp, REEL);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    var f = inp.closest('form');
    var btn = f && f.querySelector('button[type=submit], .search-form__button, .form__submit, button.btn-submit');
    if (btn) btn.click(); else if (f && f.requestSubmit) f.requestSubmit();
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  }
  function erro(){ var e = document.querySelector('.error-message, .search-result__error, .notification--error'); return e && e.textContent && e.textContent.trim(); }
  var t = setInterval(function(){
    try {
      if (Date.now() > fim) { clearInterval(t); window.PNExtrator.fail('tempo esgotado'); return; }
      var a = document.querySelector('a.button__download[href], a.download-btn[href]');
      if (a && /^https?:/.test(a.href)) { clearInterval(t); window.PNExtrator.done(a.href); return; }
      var e = erro(); if (enviado && e) { clearInterval(t); window.PNExtrator.fail(e); return; }
      if (!enviado) { var i = achaInput(); if (i) { envia(i); enviado = true; } }
    } catch (x) { }
  }, 500);
})();`;
}
