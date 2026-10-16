/*
 * Clone runtime, injected as the first script of every page we serve.
 *
 * It does not touch the client's modules. It only guards the transport, the
 * way Meowcord's 70-local-cdn.js does for Discord's client:
 *
 *   - absolute URLs to Instagram's own API hosts are rewritten to this origin,
 *     so a call the client builds with a full host still reaches our backend
 *     (and our session) instead of Instagram;
 *   - beacons and requests to Meta telemetry hosts are dropped;
 *   - realtime sockets to Meta's edge are refused, because we do not run one;
 *   - absolute URLs to Instagram's static CDN (scripts the Bootloader inserts,
 *     stylesheets, fonts, images, fetches) are sent through this origin's
 *     /__ig asset proxy, which keeps them on disk, so the page never loads code
 *     from Instagram directly and works offline from the local store.
 *
 * It holds no secret and reads no cookie.
 */
(function () {
  'use strict';
  if (window.__CLONE__) return;
  var API_HOSTS = /^(?:www\.|i\.)?instagram\.com$/i;
  var API_PATHS = /^\/(?:api\/|graphql\/|graphql$|rupload_ig|ajax\/|logging_client_events|sync\/|data\/shared_data|accounts\/)/;
  var TELEMETRY_HOSTS = /(^|\.)(facebook\.com|facebook\.net|fbcdn\.net|graph\.instagram\.com)$/i;
  var REALTIME_HOSTS = /(^|\.)(edge-chat\.instagram\.com|edge-chat\.facebook\.com|gateway\.instagram\.com)$/i;
  var ASSET_HOSTS = /^(?:static|scontent)\.cdninstagram\.com$/i;
  var stats = { rewritten: 0, dropped: 0, refusedSockets: 0, assets: 0 };

  /** An absolute static-CDN URL mapped onto the local asset proxy, else null. */
  function assetPath(raw) {
    if (typeof raw !== 'string' || !/^(?:https?:)?\/\//i.test(raw)) return null;
    var u;
    try {
      u = new URL(raw, location.href);
    } catch (e) {
      return null;
    }
    if (!ASSET_HOSTS.test(u.hostname)) return null;
    stats.assets += 1;
    return location.origin + '/__ig/' + u.host + u.pathname + u.search;
  }

  function route(raw) {
    if (typeof raw !== 'string' || !/^(?:https?:)?\/\//i.test(raw)) return { url: raw };
    var u;
    try {
      u = new URL(raw, location.href);
    } catch (e) {
      return { url: raw };
    }
    if (u.host === location.host) return { url: raw };
    if (API_HOSTS.test(u.hostname) && API_PATHS.test(u.pathname)) {
      stats.rewritten += 1;
      return { url: location.origin + u.pathname + u.search + u.hash };
    }
    if (TELEMETRY_HOSTS.test(u.hostname)) return { drop: true };
    var local = assetPath(raw);
    if (local) return { url: local };
    return { url: raw };
  }

  function mapSrcset(value) {
    return String(value)
      .split(',')
      .map(function (part) {
        var bits = part.trim().split(/\s+/);
        var local = assetPath(bits[0]);
        if (local) bits[0] = local;
        return bits.join(' ');
      })
      .join(', ');
  }

  // Element URL properties and attributes the client (and its Bootloader) set.
  var URL_PROPS = [
    [window.HTMLScriptElement, 'src'],
    [window.HTMLLinkElement, 'href'],
    [window.HTMLImageElement, 'src'],
    [window.HTMLSourceElement, 'src'],
    [window.HTMLMediaElement, 'src'],
    [window.HTMLMediaElement, 'poster'],
    [window.HTMLVideoElement, 'poster'],
  ];
  URL_PROPS.forEach(function (pair) {
    var Ctor = pair[0];
    if (!Ctor) return;
    var desc = Object.getOwnPropertyDescriptor(Ctor.prototype, pair[1]);
    if (!desc || !desc.set) return;
    Object.defineProperty(Ctor.prototype, pair[1], {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set: function (v) {
        var local = assetPath(String(v));
        desc.set.call(this, local || v);
      },
    });
  });
  [window.HTMLImageElement, window.HTMLSourceElement].forEach(function (Ctor) {
    if (!Ctor) return;
    var desc = Object.getOwnPropertyDescriptor(Ctor.prototype, 'srcset');
    if (!desc || !desc.set) return;
    Object.defineProperty(Ctor.prototype, 'srcset', {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set: function (v) {
        desc.set.call(this, mapSrcset(v));
      },
    });
  });
  // Inline-style backgrounds (the client paints image sprites this way).
  function mapCssUrls(value) {
    if (typeof value !== 'string' || value.indexOf('url(') === -1) return value;
    return value.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, function (m, q, u) {
      var local = assetPath(u);
      return local ? 'url(' + q + local + q + ')' : m;
    });
  }
  /** The prototype in the chain of an element's style that owns `prop`. */
  function styleOwner(prop) {
    var p = document.documentElement && Object.getPrototypeOf(document.documentElement.style);
    while (p) {
      if (Object.getOwnPropertyDescriptor(p, prop)) return p;
      p = Object.getPrototypeOf(p);
    }
    return null;
  }
  ['backgroundImage', 'background', 'maskImage', 'webkitMaskImage', 'listStyleImage', 'cssText'].forEach(function (prop) {
    var owner = styleOwner(prop);
    var desc = owner && Object.getOwnPropertyDescriptor(owner, prop);
    if (!desc || !desc.set) return;
    Object.defineProperty(owner, prop, {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set: function (v) {
        desc.set.call(this, mapCssUrls(v));
      },
    });
  });
  var setPropOwner = styleOwner('setProperty');
  if (setPropOwner) {
    var setProperty = setPropOwner.setProperty;
    setPropOwner.setProperty = function (name, value, priority) {
      return setProperty.call(this, name, mapCssUrls(value), priority);
    };
  }

  var setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    var n = String(name).toLowerCase();
    if (n === 'src' || n === 'href' || n === 'poster' || n === 'xlink:href') {
      var local = assetPath(String(value));
      if (local) return setAttr.call(this, name, local);
    } else if (n === 'srcset') {
      return setAttr.call(this, name, mapSrcset(value));
    } else if (n === 'style') {
      return setAttr.call(this, name, mapCssUrls(String(value)));
    }
    return setAttr.apply(this, arguments);
  };

  var realFetch = window.fetch;
  if (realFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url;
      var r = route(url);
      if (r.drop) {
        stats.dropped += 1;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (r.url !== url) {
        input = typeof input === 'string' || input instanceof URL ? r.url : new Request(r.url, input);
      }
      return realFetch.call(this, input, init);
    };
  }

  var open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var r = route(String(url));
    var args = Array.prototype.slice.call(arguments);
    if (r.drop) {
      stats.dropped += 1;
      args[1] = '/__clone/dropped';
    } else args[1] = r.url;
    return open.apply(this, args);
  };

  if (navigator.sendBeacon) {
    var beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      var r = route(String(url));
      if (r.drop) {
        stats.dropped += 1;
        return true;
      }
      return beacon(r.url, data);
    };
  }

  var RealSocket = window.WebSocket;
  if (RealSocket) {
    var Guarded = function (url, protocols) {
      var host = '';
      try {
        host = new URL(String(url), location.href).hostname;
      } catch (e) {}
      if (REALTIME_HOSTS.test(host)) {
        stats.refusedSockets += 1;
        url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/__clone/realtime-unavailable';
      }
      return protocols === undefined ? new RealSocket(url) : new RealSocket(url, protocols);
    };
    Guarded.prototype = RealSocket.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) {
      Guarded[k] = RealSocket[k];
    });
    window.WebSocket = Guarded;
  }

  Object.defineProperty(window, '__CLONE__', { value: Object.freeze({ version: 1, stats: stats }), configurable: false });
})();
