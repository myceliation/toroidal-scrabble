/* =========================================================================
 * net.js — peer-to-peer connection over WebRTC (PeerJS).
 *
 * No server of our own: PeerJS's free public broker handles the WebRTC
 * handshake. One player Hosts (gets a room code); the other Joins with it.
 * A single reliable data channel then carries JSON game messages. The host is
 * authoritative (see app.js), so this module is a thin transport + lobby UI.
 * ========================================================================= */

'use strict';

const Net = (function () {
  // Namespace our ids so short codes don't collide with other PeerJS apps
  // sharing the public broker.
  const PREFIX = 'torscrab-v1-';
  // Unambiguous alphabet (no I, L, O, 0, 1).
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  let peer = null;
  let conn = null;
  let role = null;
  let myCode = null;

  const $ = (id) => document.getElementById(id);
  function setStatus(t) {
    const el = $('netStatus');
    if (el) el.textContent = t;
  }
  function randCode(n) {
    let s = '';
    for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return s;
  }
  function lockLobby() {
    $('btnHost').disabled = true;
    $('btnJoin').disabled = true;
  }

  function route(msg) {
    if (!msg || !msg.t) return;
    if (role === 'host') {
      if (msg.t === 'move') hostHandleGuestMove(msg);
      else if (msg.t === 'rename') hostHandleRename(msg);
      else if (msg.t === 'challenge') resolveChallenge();
    } else {
      if (msg.t === 'start') guestHandleStart(msg);
      else if (msg.t === 'state') guestHandleState(msg);
      else if (msg.t === 'reject') guestHandleReject(msg);
    }
  }

  function wireConn(c) {
    conn = c;
    c.on('open', () => {
      state.online.connected = true;
      if (role === 'host') {
        setStatus('Opponent connected — you are Player 1');
        hostBeginMatch();
      } else {
        setStatus('Connected — you are Player 2');
      }
    });
    c.on('data', route);
    c.on('close', () => {
      setStatus('Opponent disconnected');
      setMessage('Connection closed. Start or join a new game to reconnect.', 'error');
    });
    c.on('error', (e) => setMessage('Connection error: ' + ((e && e.type) || e), 'error'));
  }

  function onPeerError(e) {
    const type = (e && e.type) || String(e);
    if (type === 'unavailable-id' && role === 'host') {
      // Rare code collision — pick a new one and retry.
      try { peer.destroy(); } catch (_) {}
      peer = null;
      host();
      return;
    }
    if (type === 'peer-unavailable') {
      setMessage('No game found with that code. Double-check it and try again.', 'error');
      setStatus('Local pass-and-play (same device)');
      role = null;
      try { peer.destroy(); } catch (_) {}
      peer = null;
      $('btnHost').disabled = false;
      $('btnJoin').disabled = false;
      return;
    }
    if (type === 'browser-incompatible') {
      setMessage('This browser does not support WebRTC — online play is unavailable here.', 'error');
      return;
    }
    setMessage('Network error (' + type + '). The public broker may be busy — try again.', 'error');
  }

  function host() {
    if (peer) return;
    role = 'host';
    state.online.role = 'host';
    myCode = randCode(5);
    setStatus('Starting host…');
    peer = new Peer(PREFIX + myCode, { debug: 1 });
    peer.on('open', () => {
      const el = $('netCode');
      el.classList.remove('hidden');
      el.innerHTML =
        'Room code: <b class="code">' + myCode + '</b>' +
        '<span class="net-sub">Share this — your friend taps “Join game” and enters it.</span>';
      setStatus('Waiting for opponent to join…');
      lockLobby();
    });
    peer.on('connection', (c) => {
      if (conn) { try { c.close(); } catch (_) {} return; } // one opponent only
      wireConn(c);
    });
    peer.on('error', onPeerError);
  }

  function join(code) {
    if (peer) return;
    code = (code || '').trim().toUpperCase();
    if (code.length < 4) {
      setMessage('Enter the room code your host gave you.', 'error');
      return;
    }
    role = 'guest';
    state.online.role = 'guest';
    setStatus('Connecting…');
    lockLobby();
    peer = new Peer({ debug: 1 });
    peer.on('open', () => {
      wireConn(peer.connect(PREFIX + code, { reliable: true }));
    });
    peer.on('error', onPeerError);
  }

  function send(obj) {
    if (conn && conn.open) conn.send(obj);
  }

  // ---- lobby wiring ----
  $('btnHost').addEventListener('click', host);
  $('btnJoin').addEventListener('click', () => {
    const row = $('netJoinRow');
    row.classList.toggle('hidden');
    if (!row.classList.contains('hidden')) $('joinCode').focus();
  });
  $('btnJoinGo').addEventListener('click', () => join($('joinCode').value));
  $('joinCode').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') join($('joinCode').value);
  });

  return { host, join, send };
})();
