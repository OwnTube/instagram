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
 *   - realtime sockets to Meta's edge are refused, because we do not run one.
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
  var stats = { rewritten: 0, dropped: 0, refusedSockets: 0 };

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
    return { url: raw };
  }

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
