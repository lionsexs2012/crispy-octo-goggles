const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ============== БАЗА ДАННЫХ ==============
const db = new sqlite3.Database('./messenger.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_user TEXT,
        to_user TEXT,
        encrypted_message TEXT,
        file_data TEXT,
        file_name TEXT,
        file_type TEXT,
        is_read INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// ============== ШИФРОВАНИЕ ==============
const ENCRYPTION_KEY = crypto.randomBytes(32);
const IV_LENGTH = 16;

function encrypt(text) {
    if (!text) return '';
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
    if (!text) return '';
    const parts = text.split(':');
    const iv = Buffer.from(parts.shift(), 'hex');
    const encryptedText = parts.join(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

// ============== АКТИВНЫЕ ПОЛЬЗОВАТЕЛИ ==============
let activeUsers = {};

function broadcast(data) {
    for (let user in activeUsers) {
        if (activeUsers[user].ws.readyState === WebSocket.OPEN) {
            try { activeUsers[user].ws.send(JSON.stringify(data)); } catch(e) {}
        }
    }
}

function sendToUser(username, data) {
    if (activeUsers[username] && activeUsers[username].ws.readyState === WebSocket.OPEN) {
        activeUsers[username].ws.send(JSON.stringify(data));
    }
}

function broadcastUserList() {
    const userList = Object.keys(activeUsers);
    broadcast({ type: 'user_list', users: userList });
}

function saveMessage(from, to, encryptedMsg, fileData = null, fileName = null, fileType = null) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO messages (from_user, to_user, encrypted_message, file_data, file_name, file_type) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [from, to, encryptedMsg, fileData, fileName, fileType],
            function(err) { if (err) reject(err); else resolve(this.lastID); }
        );
    });
}

function getPrivateMessages(user1, user2, limit = 100) {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT * FROM messages 
             WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
             ORDER BY created_at ASC LIMIT ?`,
            [user1, user2, user2, user1, limit],
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            }
        );
    });
}

function getAllChats(username) {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT DISTINCT 
                CASE 
                    WHEN from_user = ? THEN to_user
                    ELSE from_user
                END as chat_partner,
                MAX(created_at) as last_message_time
             FROM messages 
             WHERE from_user = ? OR to_user = ?
             GROUP BY chat_partner
             ORDER BY last_message_time DESC`,
            [username, username, username],
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            }
        );
    });
}

// ============== HTML КЛИЕНТ ==============
const HTML_PAGE = `<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <title>Secure Messenger</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            background: #0e1621;
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .login-screen {
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: #0e1621;
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
        }
        .login-card {
            background: #17212b;
            padding: 32px 24px;
            border-radius: 28px;
            width: 85%;
            max-width: 340px;
            text-align: center;
        }
        .login-card h2 { color: #fff; margin-bottom: 8px; font-size: 28px; }
        .login-card p { color: #8e9eae; font-size: 14px; margin-bottom: 24px; }
        .login-card input {
            width: 100%;
            padding: 14px 16px;
            margin: 8px 0;
            background: #242f3e;
            border: none;
            border-radius: 16px;
            color: #fff;
            font-size: 16px;
            outline: none;
        }
        .login-card button {
            width: 100%;
            padding: 14px;
            background: #2b5278;
            border: none;
            border-radius: 16px;
            color: #fff;
            font-size: 16px;
            font-weight: 600;
            margin-top: 16px;
            cursor: pointer;
        }
        .chat-container {
            display: none;
            flex: 1;
            flex-direction: column;
            height: 100vh;
        }
        .chat-header {
            background: #17212b;
            padding: 12px 16px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid #2b3b4c;
        }
        .chat-header h2 { color: #fff; font-size: 18px; }
        .header-right {
            display: flex;
            gap: 12px;
            align-items: center;
        }
        .online-badge {
            background: #2b5278;
            padding: 6px 12px;
            border-radius: 20px;
            color: #fff;
            font-size: 12px;
        }
        .connection-status {
            font-size: 11px;
            padding: 6px;
            text-align: center;
            background: #2b3b4c;
            color: #fff;
        }
        .main-layout {
            display: flex;
            flex: 1;
            overflow: hidden;
        }
        .chats-sidebar {
            width: 280px;
            background: #17212b;
            border-right: 1px solid #2b3b4c;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .chats-header {
            padding: 12px 16px;
            border-bottom: 1px solid #2b3b4c;
            color: #8e9eae;
            font-size: 12px;
            font-weight: 600;
        }
        .chats-list {
            flex: 1;
            overflow-y: auto;
        }
        .chat-item {
            padding: 12px 16px;
            cursor: pointer;
            border-bottom: 1px solid #2b3b4c;
            transition: background 0.2s;
        }
        .chat-item:hover { background: #242f3e; }
        .chat-item.active { background: #2b5278; }
        .chat-name {
            color: #fff;
            font-weight: 500;
            margin-bottom: 4px;
        }
        .chat-preview {
            color: #8e9eae;
            font-size: 11px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .chat-time {
            font-size: 10px;
            color: #6c7a89;
            margin-top: 2px;
        }
        .chat-area {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .messages-list {
            flex: 1;
            overflow-y: auto;
            padding: 16px;
        }
        .message {
            margin-bottom: 12px;
            display: flex;
            flex-direction: column;
        }
        .message.own { align-items: flex-end; }
        .message-bubble {
            max-width: 70%;
            padding: 10px 14px;
            border-radius: 18px;
            word-wrap: break-word;
            font-size: 15px;
        }
        .message.own .message-bubble {
            background: #2b5278;
            color: #fff;
            border-bottom-right-radius: 4px;
        }
        .message:not(.own) .message-bubble {
            background: #17212b;
            color: #fff;
            border-bottom-left-radius: 4px;
        }
        .message-name { font-size: 11px; color: #8e9eae; margin-bottom: 4px; margin-left: 8px; }
        .message-time { font-size: 9px; color: #6c7a89; margin-top: 4px; margin-left: 8px; }
        .message-file {
            background: #242f3e;
            padding: 8px 12px;
            border-radius: 12px;
            display: flex;
            align-items: center;
            gap: 8px;
            cursor: pointer;
        }
        .input-area {
            background: #17212b;
            padding: 12px 16px;
            display: flex;
            gap: 10px;
            border-top: 1px solid #2b3b4c;
        }
        .input-area input {
            flex: 1;
            padding: 12px 16px;
            background: #242f3e;
            border: none;
            border-radius: 24px;
            color: #fff;
            font-size: 16px;
            outline: none;
        }
        .input-area button {
            padding: 12px 20px;
            background: #2b5278;
            border: none;
            border-radius: 24px;
            color: #fff;
            font-weight: 600;
            cursor: pointer;
        }
        .file-btn {
            background: #242f3e;
            padding: 12px 16px;
            border-radius: 24px;
            cursor: pointer;
            color: #8e9eae;
        }
        @media (max-width: 600px) {
            .chats-sidebar { width: 240px; }
        }
    </style>
</head>
<body>
<div class="login-screen" id="loginScreen">
    <div class="login-card">
        <h2>🔒 Secure Messenger</h2>
        <p>Enter your name to start</p>
        <input type="text" id="usernameInput" placeholder="Your name" maxlength="24">
        <button id="loginBtn">Join</button>
    </div>
</div>
<div class="chat-container" id="chatContainer">
    <div class="chat-header">
        <h2 id="chatTitle">💬 Secure Messenger</h2>
        <div class="header-right">
            <div class="online-badge" id="onlineCount">0 online</div>
        </div>
    </div>
    <div class="connection-status" id="connStatus">Connecting...</div>
    <div class="main-layout">
        <div class="chats-sidebar">
            <div class="chats-header">💬 CHATS</div>
            <div class="chats-list" id="chatsList"></div>
        </div>
        <div class="chat-area">
            <div class="messages-list" id="messagesList"></div>
            <div class="input-area">
                <div class="file-btn" onclick="document.getElementById('fileInput').click()">📎</div>
                <input type="text" id="messageInput" placeholder="Type a message..." onkeypress="handleKeyPress(event)">
                <button onclick="sendMessage()">Send</button>
            </div>
        </div>
    </div>
</div>
<input type="file" id="fileInput" style="display:none" onchange="sendFile(this.files[0])">

<script>
    let ws = null;
    let currentUser = "";
    let currentChat = null;
    let reconnectAttempts = 0;
    let pingInterval = null;
    let allUsers = [];
    
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const WS_URL = protocol + "//" + window.location.host;
    
    const savedName = localStorage.getItem("messengerUsername");
    if (savedName) {
        document.getElementById("usernameInput").value = savedName;
    }
    
    document.getElementById("loginBtn").onclick = function() {
        login();
    };
    
    document.getElementById("usernameInput").onkeypress = function(e) {
        if (e.key === "Enter") {
            login();
        }
    };
    
    function login() {
        let name = document.getElementById("usernameInput").value.trim();
        if (!name) {
            alert("Enter your name");
            return;
        }
        if (name.length < 2) {
            alert("Name must be at least 2 characters");
            return;
        }
        currentUser = name;
        localStorage.setItem("messengerUsername", name);
        document.getElementById("loginScreen").style.display = "none";
        document.getElementById("chatContainer").style.display = "flex";
        connectWebSocket();
    }
    
    function connectWebSocket() {
        let wsUrl = WS_URL + "?username=" + encodeURIComponent(currentUser);
        if (ws) {
            try { ws.close(); } catch(e) {}
        }
        ws = new WebSocket(wsUrl);
        
        ws.onopen = function() {
            document.getElementById("connStatus").innerHTML = "🟢 Connected";
            document.getElementById("connStatus").style.background = "#1e4a3b";
            reconnectAttempts = 0;
            if (pingInterval) clearInterval(pingInterval);
            pingInterval = setInterval(function() {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: "ping" }));
                }
            }, 25000);
            loadChats();
        };
        
        ws.onmessage = function(event) {
            try {
                let data = JSON.parse(event.data);
                if (data.type === "message") {
                    if (currentChat === data.from) {
                        addMessage(data.from, data.text, false, data.file, data.fileName);
                    }
                    loadChats();
                } else if (data.type === "private_message") {
                    if (currentChat === data.from) {
                        addMessage(data.from, data.text, false, data.file, data.fileName);
                    }
                    loadChats();
                } else if (data.type === "user_list") {
                    allUsers = data.users;
                    updateOnlineCount();
                    loadChats();
                } else if (data.type === "history") {
                    displayMessages(data.messages);
                } else if (data.type === "chats_list") {
                    displayChats(data.chats);
                } else if (data.type === "system") {
                    addSystemMessage(data.text);
                }
            } catch(e) {
                console.log("Parse error:", e);
            }
        };
        
        ws.onerror = function() {
            document.getElementById("connStatus").innerHTML = "🔴 Error";
            document.getElementById("connStatus").style.background = "#6b2e2e";
        };
        
        ws.onclose = function() {
            document.getElementById("connStatus").innerHTML = "🔴 Disconnected. Reconnecting...";
            document.getElementById("connStatus").style.background = "#6b2e2e";
            if (pingInterval) clearInterval(pingInterval);
            if (reconnectAttempts < 15) {
                setTimeout(function() {
                    reconnectAttempts++;
                    connectWebSocket();
                }, 3000);
            }
        };
    }
    
    function loadChats() {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "get_chats" }));
        }
    }
    
    function displayChats(chats) {
        let container = document.getElementById("chatsList");
        if (!container) return;
        
        let html = "";
        
        for (let i = 0; i < chats.length; i++) {
            let chat = chats[i];
            let isActive = (currentChat === chat.username);
            let preview = chat.last_message ? (chat.last_message.length > 30 ? chat.last_message.substring(0, 30) + "..." : chat.last_message) : "No messages yet";
            let time = chat.last_time ? new Date(chat.last_time).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"}) : "";
            
            html += '<div class="chat-item ' + (isActive ? "active" : "") + '" onclick="selectChat(\'' + escapeHtml(chat.username) + '\')">';
            html += '<div class="chat-name">' + escapeHtml(chat.username) + '</div>';
            html += '<div class="chat-preview">' + escapeHtml(preview) + '</div>';
            if (time) html += '<div class="chat-time">' + time + '</div>';
            html += '</div>';
        }
        
        if (html === "") {
            html = '<div style="padding: 16px; color: #8e9eae; text-align: center;">No chats yet<br>Send a message to someone</div>';
        }
        
        container.innerHTML = html;
        updateOnlineCount();
    }
    
    function selectChat(username) {
        if (username === currentUser) return;
        currentChat = username;
        document.getElementById("chatTitle").innerHTML = "💬 Chat with " + escapeHtml(username);
        document.getElementById("messagesList").innerHTML = "";
        
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "get_history", with: username }));
        }
        
        loadChats();
    }
    
    function displayMessages(messages) {
        let container = document.getElementById("messagesList");
        container.innerHTML = "";
        for (let i = 0; i < messages.length; i++) {
            let msg = messages[i];
            let text = msg.encrypted_message ? msg.encrypted_message : msg.text;
            let isOwn = (msg.from_user === currentUser);
            if (msg.file_data) {
                addMessageToContainer(container, msg.from_user, null, true, msg.file_data, msg.file_name, isOwn, msg.created_at);
            } else {
                addMessageToContainer(container, msg.from_user, text, false, null, null, isOwn, msg.created_at);
            }
        }
        container.scrollTop = container.scrollHeight;
    }
    
    function addMessage(user, text, isOwn, fileData, fileName) {
        let container = document.getElementById("messagesList");
        addMessageToContainer(container, user, text, false, fileData, fileName, isOwn, new Date());
        container.scrollTop = container.scrollHeight;
    }
    
    function addMessageToContainer(container, user, text, isEncrypted, fileData, fileName, isOwn, timestamp) {
        let div = document.createElement("div");
        div.className = "message" + (isOwn ? " own" : "");
        let time = new Date(timestamp).toLocaleTimeString([], {hour: "2-digit", minute:"2-digit"});
        
        if (fileData && fileName) {
            let fileUrl = "data:application/octet-stream;base64," + fileData;
            div.innerHTML = '<div class="message-name">' + escapeHtml(user) + '</div>' +
                '<div class="message-file" onclick="downloadFile(\'' + fileUrl + '\', \'' + fileName + '\')">📎 ' + escapeHtml(fileName) + '</div>' +
                '<div class="message-time">' + time + '</div>';
        } else {
            let displayText = isEncrypted ? "🔒 Encrypted message" : text;
            div.innerHTML = '<div class="message-name">' + escapeHtml(user) + '</div>' +
                '<div class="message-bubble">' + escapeHtml(displayText) + '</div>' +
                '<div class="message-time">' + time + '</div>';
        }
        container.appendChild(div);
    }
    
    function downloadFile(url, name) {
        let a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
    }
    
    function addSystemMessage(text) {
        let container = document.getElementById("messagesList");
        let div = document.createElement("div");
        div.className = "message";
        div.style.opacity = "0.7";
        div.style.alignItems = "center";
        div.innerHTML = '<div class="message-bubble" style="background:#2b3b4c;font-size:12px;">' + escapeHtml(text) + '</div>';
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
    }
    
    function updateOnlineCount() {
        let count = allUsers.filter(u => u !== currentUser).length;
        document.getElementById("onlineCount").innerHTML = count + " online";
    }
    
    function sendMessage() {
        let text = document.getElementById("messageInput").value.trim();
        if (!text) return;
        if (!currentChat) {
            addSystemMessage("Select a chat first");
            return;
        }
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "message", text: text, to: currentChat, private: true }));
            document.getElementById("messageInput").value = "";
            addMessage(currentUser, text, true, null, null);
        } else {
            addSystemMessage("No connection");
        }
    }
    
    function sendFile(file) {
        if (!file) return;
        if (!currentChat) {
            addSystemMessage("Select a chat first");
            return;
        }
        let reader = new FileReader();
        reader.onload = function(e) {
            let base64 = e.target.result.split(",")[1];
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "file", fileName: file.name, fileType: file.type, fileData: base64, to: currentChat, private: true }));
                addMessage(currentUser, null, true, base64, file.name);
            }
        };
        reader.readAsDataURL(file);
    }
    
    function handleKeyPress(e) {
        if (e.key === "Enter") {
            sendMessage();
        }
    }
    
    function escapeHtml(str) {
        if (!str) return "";
        return str.replace(/[&<>]/g, function(m) {
            if (m === "&") return "&amp;";
            if (m === "<") return "&lt;";
            if (m === ">") return "&gt;";
            return m;
        });
    }
</script>
</body>
</html>`;

// ============== EXPRESS ==============
app.get('/', (req, res) => {
    res.send(HTML_PAGE);
});

app.get('/api/status', (req, res) => {
    res.json({ status: 'ok', users: Object.keys(activeUsers), count: Object.keys(activeUsers).length });
});

// ============== WEBSOCKET ==============
wss.on('connection', (ws, req) => {
    let currentUser = null;
    let pingInterval = null;
    
    const url = new URL(req.url, 'http://' + req.headers.host);
    const username = url.searchParams.get('username');
    
    if (!username || !username.trim()) {
        ws.close();
        return;
    }
    
    currentUser = username.trim();
    
    db.run(`INSERT OR IGNORE INTO users (username) VALUES (?)`, [currentUser]);
    
    if (activeUsers[currentUser]) {
        try { activeUsers[currentUser].ws.close(); } catch(e) {}
        delete activeUsers[currentUser];
    }
    
    activeUsers[currentUser] = { ws: ws, lastPing: Date.now() };
    console.log(`✅ ${currentUser} connected`);
    
    ws.send(JSON.stringify({ type: 'system', text: `Welcome, ${currentUser}!` }));
    broadcastUserList();
    
    pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
        }
    }, 25000);
    
    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data);
            
            if (message.type === 'message' && message.text && message.to) {
                let encryptedMsg = encrypt(message.text);
                await saveMessage(currentUser, message.to, encryptedMsg);
                
                if (activeUsers[message.to]) {
                    sendToUser(message.to, {
                        type: 'private_message',
                        from: currentUser,
                        text: message.text,
                        timestamp: Date.now()
                    });
                }
                console.log(`📨 ${currentUser} -> ${message.to}: ${message.text}`);
                
            } else if (message.type === 'file' && message.fileData && message.to) {
                await saveMessage(currentUser, message.to, '', message.fileData, message.fileName, message.fileType);
                
                if (activeUsers[message.to]) {
                    sendToUser(message.to, {
                        type: 'private_message',
                        from: currentUser,
                        file: message.fileData,
                        fileName: message.fileName,
                        timestamp: Date.now()
                    });
                }
                console.log(`📎 ${currentUser} -> ${message.to}: ${message.fileName}`);
                
            } else if (message.type === 'get_history' && message.with) {
                let history = await getPrivateMessages(currentUser, message.with);
                ws.send(JSON.stringify({ type: 'history', messages: history }));
                
            } else if (message.type === 'get_chats') {
                let chats = await getAllChats(currentUser);
                let chatList = [];
                for (let chat of chats) {
                    let lastMsg = await getPrivateMessages(currentUser, chat.chat_partner, 1);
                    chatList.push({
                        username: chat.chat_partner,
                        last_message: lastMsg.length > 0 ? (lastMsg[0].encrypted_message ? '🔒 Encrypted' : lastMsg[0].text) : null,
                        last_time: lastMsg.length > 0 ? lastMsg[0].created_at : null
                    });
                }
                ws.send(JSON.stringify({ type: 'chats_list', chats: chatList }));
                
            } else if (message.type === 'ping') {
                if (activeUsers[currentUser]) {
                    activeUsers[currentUser].lastPing = Date.now();
                }
            }
        } catch(e) {
            console.log('Error:', e.message);
        }
    });
    
    ws.on('close', () => {
        console.log(`❌ ${currentUser} disconnected`);
        if (pingInterval) clearInterval(pingInterval);
        if (currentUser && activeUsers[currentUser]) {
            delete activeUsers[currentUser];
            broadcastUserList();
        }
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`🎉 Server running on port ${PORT}`);
    console.log(`🔒 Encryption enabled`);
    console.log(`💾 Database: messenger.db`);
});
