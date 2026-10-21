'use strict';

/**
 * Narrow, reviewable patches to the original client's JavaScript.
 *
 * The client's bundles are concatenations of Haste module definitions,
 * `__d("ModuleName", [deps], function factory(...) {...}, flags)`. A patch
 * names ONE module and a find/replace inside that module's definition only,
 * the way Equicord patches name a webpack module by a unique string. A patch
 * whose module or text is not found is reported, never applied elsewhere, so a
 * client update turns a stale patch into a visible miss instead of a silent
 * mis-edit.
 *
 * Patches are the last resort. Prefer, in order: answering the request on the
 * server (src/clone), editing bootstrap data (src/shell/personalize.js), the
 * transport guard (src/shell/runtime.js), then a patch here. Add entries to
 * PATCHES only when a live run shows a module that cannot work any other way,
 * each with a `why`, and keep them minimal. Finds are exact minified text from
 * the build they were read from; after a client update a patch may miss, which
 * /__loader/health reports (shell.bundlePatches[].missedFind).
 */

/** @type {{ id: string, module: string, find: string | RegExp, replace: string, why: string }[]} */
const PATCHES = [
  /*
   * Sign-up without a contact point. Accounts here need only a username and a
   * password (no email, no phone, no code), so the genuine form's "Mobile
   * number or email" field and its "You may receive notifications from us"
   * text (both rendered by CAARegistrationFormCPInput.react) are removed from
   * the Instagram layout, and the form stops requiring that field.
   */
  {
    id: 'signup-no-contactpoint-field',
    module: 'CAARegistrationFormDesktop.react',
    find: 'le=T?[Y,Z,ne,ee,te]:[ee,te,Z,Y,J]',
    replace: 'le=T?[Y,Z,ne,ee,te]:[te,Z,Y,J]',
    why: 'The Instagram (non-T) field list starts with the contact-point input `ee`; drop it from that list only.',
  },
  {
    id: 'signup-contactpoint-not-validated',
    module: 'CAARegistrationFormDesktopReducer',
    find: 't=g(t,"HandleSubmit"),t=h(t,"HandleSubmit")',
    replace: 'n!==1&&(t=g(t,"HandleSubmit")),t=h(t,"HandleSubmit")',
    why: 'validateForm runs the contact-point check `g`; skip it for appType 1 (Instagram), where the field is not shown.',
  },
  {
    id: 'signup-contactpoint-not-required',
    module: 'CAARegistrationFormDesktopReducer',
    find: 's=t.cp.valid&&t.password.valid&&r',
    replace: 's=(n===1||t.cp.valid)&&t.password.valid&&r',
    why: 'The form is valid without a contact point for appType 1; the server re-validates every field.',
  },
  /*
   * After a successful Instagram sign-up the form normally opens the
   * contact-point confirmation-code page. There is no contact point and no code
   * here; the server has already created the account and signed the browser in,
   * and answers with a same-site redirect_uri, which this follows instead. With
   * no redirect_uri the original behaviour is kept.
   */
  {
    id: 'signup-success-follows-redirect',
    module: 'CAARegistrationHomepageSubmitButton.react',
    find: 'M&&C.submitResult===0?(a({type:"ResetFormAfterSubmitSuccess"}),J({',
    replace:
      'M&&C.submitResult===0&&C.redirectURI.length>0?(a({type:"ResetFormAfterSubmitSuccess"}),r("goForceFullPageRedirectTo")(C.redirectURI)):M&&C.submitResult===0?(a({type:"ResetFormAfterSubmitSuccess"}),J({',
    why: 'Skip the confirmation-code page when the server signed the user in and named where to go.',
  },
  /*
   * Live Direct messages. The client's message stream (WMI over the DGW
   * gateway) picks its gateway from the page's own domain and knows only
   * Meta's, so on this origin it has no endpoint and never connects. Resolve it
   * as on instagram.com; the runtime then points the gateway socket at this
   * server's realtime endpoint (src/realtime/), like the client's other
   * realtime sockets.
   */
  {
    id: 'dgw-gateway-for-this-origin',
    module: 'DGWEnvUtil',
    find: 'o=m(n,t.getPath())',
    replace: 'o=m("www.instagram.com",t.getPath())',
    why: 'Pick the instagram.com gateway (wss://gateway.instagram.com/ws); the runtime redirects that host here.',
  },
];

/** Locate each `__d("Name",` definition: start offsets keyed by module name. */
function moduleSpans(source) {
  const spans = [];
  const re = /__d\(\s*(["'])([^"'\\]{1,200})\1\s*,/g;
  let m;
  while ((m = re.exec(source))) spans.push({ name: m[2], start: m.index });
  for (let i = 0; i < spans.length; i += 1) spans[i].end = i + 1 < spans.length ? spans[i + 1].start : source.length;
  return spans;
}

function createPatcher(patches = PATCHES) {
  const report = new Map(patches.map((p) => [p.id, { id: p.id, module: p.module, applied: 0, missedFind: 0 }]));

  function apply(source) {
    if (!patches.length || typeof source !== 'string' || !source.includes('__d(')) return { source, applied: [] };
    const spans = moduleSpans(source);
    const byName = new Map();
    for (const s of spans) if (!byName.has(s.name)) byName.set(s.name, s);
    // Patches for the same module are applied in order to that module's text.
    const edits = new Map();
    for (const patch of patches) {
      const span = byName.get(patch.module);
      if (!span) continue;
      const edit = edits.get(span) || { span, text: source.slice(span.start, span.end), ids: [] };
      const next = edit.text.replace(patch.find, patch.replace);
      if (next === edit.text) {
        report.get(patch.id).missedFind += 1;
        continue;
      }
      edit.text = next;
      edit.ids.push(patch.id);
      edits.set(span, edit);
    }
    if (!edits.size) return { source, applied: [] };
    const ordered = [...edits.values()].sort((x, y) => y.span.start - x.span.start);
    let out = source;
    const applied = [];
    for (const e of ordered) {
      out = out.slice(0, e.span.start) + e.text + out.slice(e.span.end);
      for (const id of e.ids) {
        report.get(id).applied += 1;
        applied.push(id);
      }
    }
    return { source: out, applied: patches.map((p) => p.id).filter((id) => applied.includes(id)) };
  }

  return { apply, report: () => [...report.values()], count: patches.length };
}

module.exports = { createPatcher, moduleSpans, PATCHES };
