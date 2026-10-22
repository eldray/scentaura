'use strict';
/** Tiny helpers that print escaped HTML form fields, so the admin pages stay short and consistent. */
const esc = s => String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function wrap(label, control, o = {}) {
  return `<div class="field${o.cls ? ' ' + esc(o.cls) : ''}">${label ? `<label for="${esc(o.id)}">${esc(label)}${o.required ? ' <span class="req">*</span>' : ''}</label>` : ''}${control}${o.help ? `<small class="help">${esc(o.help)}</small>` : ''}</div>`;
}
const attrs = o => [
  o.required ? 'required' : '', o.readonly ? 'readonly' : '', o.disabled ? 'disabled' : '',
  o.min !== undefined ? `min="${esc(o.min)}"` : '', o.max !== undefined ? `max="${esc(o.max)}"` : '', o.step !== undefined ? `step="${esc(o.step)}"` : '',
  o.maxlength ? `maxlength="${esc(o.maxlength)}"` : '', o.placeholder ? `placeholder="${esc(o.placeholder)}"` : '', o.autocomplete ? `autocomplete="${esc(o.autocomplete)}"` : '',
  o.inputmode ? `inputmode="${esc(o.inputmode)}"` : '', o.list ? `list="${esc(o.list)}"` : '', o.minlength ? `minlength="${esc(o.minlength)}"` : ''
].filter(Boolean).join(' ');

module.exports = {
  esc,
  input(name, label, value, o = {}) {
    const id = o.id || 'f_' + name;
    return wrap(label, `<input id="${esc(id)}" name="${esc(name)}" type="${esc(o.type || 'text')}" value="${esc(value)}" ${attrs(o)}>`, { ...o, id });
  },
  textarea(name, label, value, o = {}) {
    const id = o.id || 'f_' + name;
    return wrap(label, `<textarea id="${esc(id)}" name="${esc(name)}" rows="${o.rows || 4}" ${attrs(o)}>${esc(value)}</textarea>`, { ...o, id });
  },
  select(name, label, options, selected, o = {}) {
    const id = o.id || 'f_' + name;
    const opts = options.map(x => {
      const v = typeof x === 'object' ? x.value : x, l = typeof x === 'object' ? x.label : x;
      return `<option value="${esc(v)}"${String(v) === String(selected) ? ' selected' : ''}>${esc(l)}</option>`;
    }).join('');
    return wrap(label, `<select id="${esc(id)}" name="${esc(name)}" ${attrs(o)}>${opts}</select>`, { ...o, id });
  },
  check(name, label, checked, o = {}) {
    const id = o.id || 'f_' + name;
    return `<div class="field check"><label for="${esc(id)}"><input id="${esc(id)}" type="checkbox" name="${esc(name)}" value="${esc(o.value || '1')}"${checked ? ' checked' : ''}> ${esc(label)}</label>${o.help ? `<small class="help">${esc(o.help)}</small>` : ''}</div>`;
  },
  hidden(name, value) { return `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`; }
};
