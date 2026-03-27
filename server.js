const WebSocket = require('ws');
const http = require('http');
const express = require('express');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let users = {};

// Простая HTML страница
const PAGE = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Simple Chat</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: Arial, sans-serif;
            background: #0e1621;
            height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .login {
            background: #17212b;
            padding: 30px;
            border-radius: 20px;
            width: 300px;
            text-align: center;
        }
        .login h2 { color: #fff; margin-bottom: 20px; }
        .login input {
            width: 100%;
            padding: 12px;
            margin: 10px 0;
            background: #242f3e;
            border: none;
            border-radius: 12px;
            color: #fff;
        }
        .login button {
            width: 100%;
            padding: 12px;
            background: #2b5278;
            border: none;
            border-radius: 12px;
            color: #fff;
            font-weight: bold;
            cursor: pointer;
        }
        .chat {
            display: none;
            width: 100%;
            height: 100vh;
            flex-direction: column;
        }
        .header {
            background: #17212b;
            padding: 15px;
            color: #fff;
            text-align: center;
        }
        .messages {
            flex: 1;
            overflow-y: auto;
            padding: 15px;
        }
        .msg {
            margin: 10px 0;
        }
        .msg.own { text-align: right; }
        .msg-bubble {
            display: inline-block;
            padding: 8px 12px;
            border-radius: 18px;
            background: #17212b;
            color: #fff;
            max-width: 70%;
        }
        .msg.own .msg-bubble { background: #2b5278; }
        .input-area {
            background: #17212b;
            padding: 15px;
            display: flex;
            gap: 10px;
        }
        .input-area input {
            flex: 1;
            padding: 12px;
            background: #242f3e;
            border: none;
            border-radius: 24px;
            color: #fff;
        }
        .input-area button {
            padding: 12px 20px;
            background: #2b5278;
            border: none;
            border-radius: 24px;
            color: #fff;
            cursor: pointer;
        }
        .users {
            background: #17212b;
            padding: 10px;
            display: flex;
            gap: 8px;
            overflow-x: auto;
            border-bottom: 1px solid #2b3b4c;
        }
        .user-chip {
            background: #242f3e;
            padding: 5px 12px;
            border-radius: 20px;
            color: #fff;
            cursor: pointer;
        }
        .user-chip.active { background: #2b5278; }
    </style>
</head>
<body>

<div id="loginPage" class="login">
    <h2>🔒 Simple Chat</h2>
    <input type="text" id="username" placeholder="Your name">
    <button id="joinBtn">Join</button>
</div>

<div id="chatPage" class="chat">
    <div class="header">
        <span id="chatTitle">Chat</span>
    </div>
    <div class="users" id="usersList"></div>
    <div class="messages" id="messages"></div>
    <div class="input-area">
        <input type="text" id="messageInput" placeholder="Type a message...">
        <button id="sendBtn">Send</button>
    </div>
</div>

<script>
    const loginPage = document.getElementById('loginPage');
    const chatPage = document.getElementById('chatPage');
    const usernameInput = document.getElementById('username');
    const joinBtn = document.getElementById('joinBtn');
    const messagesDiv = document.getElementById('messages');
    const messageInput = document.getElementById('messageInput');
    const sendBtn = document.getElementById('sendBtn');
    const usersList = document.getElementById('usersList');
    const chatTitle = document.getElementById('chatTitle');
    
    let ws = null;
    let currentUser = '';
    let currentChat = '';
    
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const WS_URL = protocol + '//' + location.host;
    
    function login() {
        const name = usernameInput.value.trim();
        if (!name) { alert('Enter name'); return; }
        if (name.length < 2) { alert('Min 2 chars'); return; }
        currentUser = name;
        loginPage.style.display = 'none';
        chatPage.style.display = 'flex';
        connect();
    }
    
    function connect() {
        ws = new WebSocket(WS_URL + '?username=' + encodeURIComponent(currentUser));
        
        ws.onopen = () => {
            console.log('Connected');
            document.getElementById('chatTitle').innerHTML = 'Connected';
        };
        
        ws.onmessage = (e) => {
            const data = JSON.parse(e.data);
            if (data.type === 'message') {
                if (currentChat === data.from || data.from === currentUser) {
                    addMessage(data.from, data.text, data.from === currentUser);
                }
                loadUsers();
            } else if (data.type === 'users') {
                updateUsers(data.users);
            } else if (data.type === 'history') {
                data.messages.forEach(msg => {
                    addMessage(msg.from_user, msg.message, msg.from_user === currentUser);
                });
            } else if (data.type === 'system') {
                addSystemMessage(data.text);
            }
        };
        
        ws.onerror = () => console.log('Error');
        ws.onclose = () => setTimeout(connect, 3000);
    }
    
    function updateUsers(users) {
        let html = '';
        users.forEach(u => {
            if (u !== currentUser) {
                const active = currentChat === u ? 'active' : '';
                html += '<div class="user-chip ' + active + '" onclick="selectChat(\'' + u + '\')">' + u + '</div>';
            }
        });
        usersList.innerHTML = html || '<div style="color:#8e9eae;padding:5px;">No other users</div>';
    }
    
    function loadUsers() {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'get_users' }));
        }
    }
    
    function selectChat(user) {
        currentChat = user;
        chatTitle.innerHTML = 'Chat with ' + user;
        messagesDiv.innerHTML = '';
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'get_history', with: user }));
        }
        loadUsers();
    }
    
    function sendMessage() {
        const text = messageInput.value.trim();
        if (!text) return;
        if (!currentChat) { addSystemMessage('Select a user first'); return; }
        ws.send(JSON.stringify({ type: 'message', text: text, to: currentChat }));
        messageInput.value = '';
        addMessage(currentUser, text, true);
    }
    
    function addMessage(user, text, isOwn) {
        const div = document.createElement('div');
        div.className = 'msg' + (isOwn ? ' own' : '');
        div.innerHTML = '<div class="msg-bubble"><b>' + escapeHtml(user) + '</b><br>' + escapeHtml(text) + '</div>';
        messagesDiv.appendChild(div);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }
    
    function addSystemMessage(text) {
        const div = document.createElement('div');
        div.style.textAlign = 'center';
        div.style.color = '#8e9eae';
        div.style.padding = '5px';
        div.innerText = text;
        messagesDiv.appendChild(div);
    }
    
    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;');
    }
    
    joinBtn.onclick = login;
    sendBtn.onclick = sendMessage;
    messageInput.onkeypress = (e) => { if (e.key === 'Enter') sendMessage(); };
    usernameInput.onkeypress = (e) => { if (e.key === 'Enter') login(); };
    
    window.selectChat = selectChat;
</script>
</body>
</html>`;

app.get('/', (req, res) => res.send(PAGE));

// API статус
app.get('/api/status', (req, res) => {
    res.json({ status: 'ok', users: Object.keys(users), count: Object.keys(users).length });
});

// WebSocket
wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://' + req.headers.host);
    const username = url.searchParams.get('username');
    
    if (!username) { ws.close(); return; }
    
    if (users[username]) {
        try { users[username].close(); } catch(e) {}
    }
    users[username] = ws;
    console.log('✅ ' + username + ' connected');
    
    ws.send(JSON.stringify({ type: 'system', text: 'Welcome ' + username }));
    broadcastUsers();
    
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.type === 'message' && msg.text && msg.to && users[msg.to]) {
                users[msg.to].send(JSON.stringify({
                    type: 'message',
                    from: username,
                    text: msg.text,
                    time: Date.now()
                }));
                console.log('📨 ' + username + ' -> ' + msg.to + ': ' + msg.text);
            } else if (msg.type === 'get_users') {
                broadcastUsers();
            } else if (msg.type === 'get_history') {
                ws.send(JSON.stringify({ type: 'history', messages: [] }));
            }
        } catch(e) {}
    });
    
    ws.on('close', () => {
        delete users[username];
        broadcastUsers();
        console.log('❌ ' + username + ' disconnected');
    });
});

function broadcastUsers() {
    const userList = Object.keys(users);
    for (let user in users) {
        if (users[user] && users[user].readyState === WebSocket.OPEN) {
            users[user].send(JSON.stringify({ type: 'users', users: userList }));
        }
    }
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log('Server on port ' + PORT);
});
