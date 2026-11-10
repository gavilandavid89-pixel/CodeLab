/**
 * CodeLab-authenticated Penpot notification WebSocket.
 *
 * The caller supplies the session-bound identity adapter. This module never
 * treats browser-supplied team/file IDs as authorization; every subscription
 * is resolved back through that adapter before joining an event topic.
 */
'use strict';

const { WebSocket, WebSocketServer } = require('ws');
const transit = require('transit-js');
const { decodeTransit, encodeTransit } = require('./penpot-transit');
const { UUID_RE, deriveUuid } = require('./penpot-identity');

const WS_PATH = '/ws/notifications';
const MAX_MESSAGE_BYTES = 256 * 1024;
const DEFAULT_MAX_CONNECTIONS_PER_PROFILE = 8;
const DEFAULT_MESSAGES_PER_MINUTE = 120;

function field(message, name) {
  if (transit.isMap(message)) {
    const keywordValue = message.get(transit.keyword(name));
    if (keywordValue !== undefined) return keywordValue;
    return message.get(name);
  }
  if (message && typeof message === 'object' && !Array.isArray(message)) {
    if (Object.prototype.hasOwnProperty.call(message, name)) return message[name];
    if (Object.prototype.hasOwnProperty.call(message, ':' + name)) return message[':' + name];
  }
  return undefined;
}

function idString(value) {
  if (value == null) return '';
  return String(value);
}

function keywordName(value) {
  return idString(value).replace(/^:/, '');
}

function transitValue(key, value) {
  if (typeof value === 'string' && /(?:^|-)id$/.test(key) && UUID_RE.test(value)) {
    return transit.uuid(value);
  }
  return value;
}

function makeMessage(type, fields = {}) {
  const result = transit.map();
  result.set(transit.keyword('type'), transit.keyword(type));
  for (const [key, value] of Object.entries(fields)) {
    result.set(transit.keyword(key), transitValue(key, value));
  }
  return result;
}

function cloneWithFields(message, fields) {
  const result = transit.map();
  if (transit.isMap(message)) {
    message.forEach((value, key) => result.set(key, value));
  } else if (message && typeof message === 'object' && !Array.isArray(message)) {
    for (const [key, value] of Object.entries(message)) {
      result.set(transit.keyword(key.replace(/^:/, '')), value);
    }
  }
  for (const [key, value] of Object.entries(fields)) {
    result.set(transit.keyword(key), transitValue(key, value));
  }
  return result;
}

function sameOrigin(req) {
  const origin = req.headers && req.headers.origin;
  if (!origin) return true;
  let parsed;
  try { parsed = new URL(origin); } catch (_) { return false; }
  const host = String(req.headers.host || '').toLowerCase();
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || (req.socket && req.socket.encrypted ? 'https' : 'http');
  return parsed.host.toLowerCase() === host && parsed.protocol === protocol + ':';
}

function writeHttpError(socket, status, label) {
  if (!socket || socket.destroyed) return;
  const reason = label || 'Rejected';
  try {
    socket.write('HTTP/1.1 ' + status + ' ' + reason + '\r\n' +
      'Connection: close\r\n' +
      'Cache-Control: no-store\r\n' +
      'Content-Length: 0\r\n\r\n');
  } catch (_) {}
  socket.destroy();
}

function attachPenpotWebSocket(server, options = {}) {
  const identity = options.identity;
  if (!identity || typeof identity.resolveWorkspace !== 'function' ||
      typeof identity.resolveTeam !== 'function' || typeof identity.resolveFile !== 'function') {
    throw new TypeError('penpot_websocket_identity_adapter_required');
  }

  const maxConnections = Number.isInteger(options.maxConnectionsPerProfile) && options.maxConnectionsPerProfile > 0
    ? options.maxConnectionsPerProfile
    : DEFAULT_MAX_CONNECTIONS_PER_PROFILE;
  const messagesPerMinute = Number.isInteger(options.messagesPerMinute) && options.messagesPerMinute > 0
    ? options.messagesPerMinute
    : DEFAULT_MESSAGES_PER_MINUTE;

  const clients = new Set();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false
  });

  function send(client, message) {
    if (!client || client.socket.readyState !== WebSocket.OPEN) return;
    try {
      client.socket.send(encodeTransit(message, { maxBytes: MAX_MESSAGE_BYTES }));
    } catch (_) {
      try { client.socket.close(1011, 'serialization_error'); } catch (_) {}
    }
  }

  function peersForFile(fileId, exceptSessionId) {
    return [...clients].filter(client =>
      client.fileId === fileId &&
      client.sessionId !== exceptSessionId &&
      client.socket.readyState === WebSocket.OPEN
    );
  }

  function peersForProfile(profileId, exceptSessionId) {
    return [...clients].filter(client =>
      client.profileId === profileId &&
      client.sessionId !== exceptSessionId &&
      client.socket.readyState === WebSocket.OPEN
    );
  }

  function publishFileEvent(type, source, extra = {}) {
    const message = makeMessage(type, {
      'file-id': source.fileId,
      'profile-id': source.profileId,
      'session-id': source.sessionId,
      ...extra
    });
    for (const peer of peersForFile(source.fileId, source.sessionId)) send(peer, message);
  }

  function removeClient(client, announce = true) {
    if (!clients.has(client)) return;
    if (announce && client.fileId) publishFileEvent('disconnect', client);
    clients.delete(client);
  }

  async function handleMessage(client, raw) {
    const message = decodeTransit(raw, { maxBytes: MAX_MESSAGE_BYTES });
    const type = keywordName(field(message, 'type'));
    const fileId = idString(field(message, 'file-id'));
    const teamId = idString(field(message, 'team-id'));

    if (type === 'keepalive') return;

    if (type === 'subscribe-team') {
      await identity.resolveTeam(client.request, teamId);
      client.teamId = teamId;
      return;
    }

    if (type === 'subscribe-file') {
      const resolved = await identity.resolveFile(client.request, fileId);
      if (client.fileId && client.fileId !== fileId) {
        publishFileEvent('leave-file', client);
      }
      client.fileId = resolved.ids ? resolved.ids.fileId : fileId;
      client.projectId = resolved.project && resolved.project.id || null;
      for (const peer of peersForFile(client.fileId, client.sessionId)) {
        send(client, makeMessage('presence', {
          'file-id': client.fileId,
          'profile-id': peer.profileId,
          'session-id': peer.sessionId
        }));
      }
      publishFileEvent('join-file', client);
      return;
    }

    if (type === 'unsubscribe-file') {
      if (client.fileId && fileId === client.fileId) {
        publishFileEvent('leave-file', client);
        client.fileId = null;
        client.projectId = null;
      }
      return;
    }

    if (type === 'broadcast') {
      const outgoing = cloneWithFields(message, {
        'subs-id': client.profileId,
        'profile-id': client.profileId,
        'session-id': client.sessionId
      });
      for (const peer of peersForProfile(client.profileId, client.sessionId)) send(peer, outgoing);
      return;
    }

    if (type === 'pointer-update') {
      if (!client.fileId || fileId !== client.fileId) return;
      const outgoing = cloneWithFields(message, {
        'subs-id': client.fileId,
        'profile-id': client.profileId,
        'session-id': client.sessionId
      });
      for (const peer of peersForFile(client.fileId, client.sessionId)) send(peer, outgoing);
    }
  }

  async function onUpgrade(req, socket, head) {
    let url;
    try { url = new URL(req.url || '/', 'http://localhost'); }
    catch (_) { return writeHttpError(socket, 400, 'Bad Request'); }
    if (url.pathname !== WS_PATH) return;

    if (!sameOrigin(req)) return writeHttpError(socket, 403, 'Forbidden');
    const sessionId = url.searchParams.get('session-id') || '';
    if (!UUID_RE.test(sessionId)) return writeHttpError(socket, 400, 'Bad Request');

    let context;
    try {
      context = await identity.resolveWorkspace(req);
    } catch (error) {
      const status = Number.isInteger(error && error.status) ? error.status : 401;
      return writeHttpError(socket, status, status === 403 ? 'Forbidden' : 'Unauthorized');
    }

    const profileId = deriveUuid('codelab:penpot:profile', context.user.provider, context.user.id);
    const activeForProfile = [...clients].filter(client => client.profileId === profileId).length;
    if (activeForProfile >= maxConnections) return writeHttpError(socket, 429, 'Too Many Requests');

    wss.handleUpgrade(req, socket, head, ws => {
      const client = {
        socket: ws,
        request: req,
        user: context.user,
        workspaceId: context.workspaceId,
        profileId,
        teamId: deriveUuid('codelab:penpot:team', context.workspaceId),
        sessionId,
        fileId: null,
        projectId: null,
        windowStartedAt: Date.now(),
        messageCount: 0
      };
      clients.add(client);
      wss.emit('connection', ws, req, client);
    });
  }

  wss.on('connection', (socket, _req, client) => {
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, 'text_transit_required');
        return;
      }
      const now = Date.now();
      if (now - client.windowStartedAt >= 60_000) {
        client.windowStartedAt = now;
        client.messageCount = 0;
      }
      client.messageCount += 1;
      if (client.messageCount > messagesPerMinute) {
        socket.close(1008, 'rate_limit');
        return;
      }
      handleMessage(client, data).catch(() => {
        socket.close(1008, 'invalid_or_unauthorized_message');
      });
    });
    socket.on('close', () => removeClient(client));
    socket.on('error', () => removeClient(client));
  });

  server.on('upgrade', onUpgrade);

  return Object.freeze({
    wss,
    close() {
      server.off('upgrade', onUpgrade);
      for (const client of clients) {
        removeClient(client, false);
        try { client.socket.close(1001, 'server_shutdown'); } catch (_) {}
      }
      wss.close();
    },
    getConnectionCount() { return clients.size; }
  });
}

module.exports = {
  MAX_MESSAGE_BYTES,
  WS_PATH,
  attachPenpotWebSocket,
  field,
  makeMessage
};
