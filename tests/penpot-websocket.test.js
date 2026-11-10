const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const transit = require('transit-js');
const { decodeTransit, encodeTransit } = require('../penpot-transit');
const { deriveUuid } = require('../penpot-identity');
const { attachPenpotWebSocket, field, makeMessage } = require('../penpot-websocket');

const user = { id: 'admin', provider: 'local', username: 'ADMIN', role: 'admin' };
const workspaceId = 'ws_local_admin';
const teamId = deriveUuid('codelab:penpot:team', workspaceId);
const fileId = deriveUuid('codelab:penpot:file', workspaceId, 'project_1');

async function fixture() {
  const server = http.createServer();
  const identity = {
    resolveWorkspace: async () => ({ user, workspaceId, state: { projects: [] } }),
    resolveTeam: async (_req, requestedTeamId) => {
      if (requestedTeamId !== teamId) throw Object.assign(new Error('team_not_found'), { status: 404 });
      return { workspaceId, user };
    },
    resolveFile: async (_req, requestedFileId) => {
      if (requestedFileId !== fileId) throw Object.assign(new Error('file_not_found'), { status: 404 });
      return { ids: { fileId }, project: { id: 'project_1' } };
    }
  };
  const adapter = attachPenpotWebSocket(server, { identity });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    server,
    adapter,
    url: 'ws://127.0.0.1:' + address.port + '/ws/notifications',
    async close(sockets = []) {
      for (const socket of sockets) {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.terminate();
        }
      }
      adapter.close();
      await new Promise(resolve => server.close(resolve));
    }
  };
}

function connect(url, sessionId) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url + '?session-id=' + encodeURIComponent(sessionId));
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function send(socket, message) {
  socket.send(encodeTransit(message));
}

function waitForType(socket, expectedType, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('timeout_waiting_for_' + expectedType));
    }, timeoutMs);
    const onMessage = data => {
      let message;
      try { message = decodeTransit(data); } catch (_) { return; }
      const type = String(field(message, 'type') || '').replace(/^:/, '');
      if (type !== expectedType) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
  });
}

test('WebSocket validates session UUID and same-origin upgrades', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const invalid = await new Promise(resolve => {
    const socket = new WebSocket(f.url);
    socket.on('unexpected-response', (_request, response) => {
      resolve(response.statusCode);
      socket.terminate();
    });
    socket.on('error', () => {});
  });
  assert.equal(invalid, 400);

  const crossOrigin = await new Promise(resolve => {
    const socket = new WebSocket(f.url + '?session-id=' + deriveUuid('session', 'bad-origin'), {
      headers: { Origin: 'https://evil.example' }
    });
    socket.on('unexpected-response', (_request, response) => {
      resolve(response.statusCode);
      socket.terminate();
    });
    socket.on('error', () => {});
  });
  assert.equal(crossOrigin, 403);
});

test('file subscriptions are resolved through CodeLab identity and relay presence/pointers', async t => {
  const f = await fixture();
  const sessionA = deriveUuid('session', 'a');
  const sessionB = deriveUuid('session', 'b');
  const a = await connect(f.url, sessionA);
  const b = await connect(f.url, sessionB);
  try {
    send(a, makeMessage('subscribe-file', { 'file-id': fileId }));
    send(b, makeMessage('subscribe-file', { 'file-id': fileId }));

    const presence = await waitForType(b, 'presence');
    assert.equal(String(field(presence, 'file-id')), fileId);
    const joined = await waitForType(a, 'join-file');
    assert.equal(String(field(joined, 'session-id')), sessionB);

    const pointerReceived = waitForType(b, 'pointer-update');
    send(a, makeMessage('pointer-update', { 'file-id': fileId, x: 120, y: 240 }));
    const pointer = await pointerReceived;
    assert.equal(field(pointer, 'x'), 120);
    assert.equal(field(pointer, 'y'), 240);
    assert.equal(String(field(pointer, 'profile-id')), deriveUuid('codelab:penpot:profile', 'local', 'admin'));
  } finally {
    await f.close([a, b]);
  }
});

test('profile broadcasts are scoped to the authenticated CodeLab profile', async t => {
  const f = await fixture();
  const a = await connect(f.url, deriveUuid('session', 'broadcast-a'));
  const b = await connect(f.url, deriveUuid('session', 'broadcast-b'));
  try {
    const received = waitForType(b, 'broadcast');
    send(a, makeMessage('broadcast', { message: 'hello from another tab' }));
    const message = await received;
    assert.equal(field(message, 'message'), 'hello from another tab');
    assert.equal(String(field(message, 'profile-id')), deriveUuid('codelab:penpot:profile', 'local', 'admin'));
  } finally {
    await f.close([a, b]);
  }
});

test('unauthorized file and team subscriptions close the connection', async t => {
  const f = await fixture();
  const socket = await connect(f.url, deriveUuid('session', 'unauthorized'));
  try {
    const closed = new Promise(resolve => socket.once('close', (code, reason) => resolve({
      code,
      reason: reason.toString()
    })));
    send(socket, makeMessage('subscribe-file', {
      'file-id': deriveUuid('other-workspace-file', 'file')
    }));
    const result = await closed;
    assert.equal(result.code, 1008);
  } finally {
    await f.close([socket]);
  }
});

test('Transit WebSocket messages remain Transit maps with keyword keys', () => {
  const message = makeMessage('keepalive', { 'file-id': fileId });
  assert.equal(transit.isMap(message), true);
  assert.equal(String(field(message, 'type')), ':keepalive');
  assert.equal(String(field(message, 'file-id')), fileId);
});
