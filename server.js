const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const db = new sqlite3.Database('./messenger.db');

db.serialize(() => {
    db.run(CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        display_name TEXT,
        bio TEXT,
        avatar TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ));
    db.run(CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_user TEXT,
        to_user TEXT,
        message TEXT,
        file_data TEXT,
        file_name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ));
});

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
    if (!text || !text.includes(':')) return text;
    const parts = text.split(':');
    const iv = Buffer.from(parts.shift(), 'hex');
    const encryptedText = parts.join(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

let activeUsers = {};

function broadcast(data) {
    for (let user in activeUsers) {
        if (activeUsers[user] && activeUsers[user].readyState === WebSocket.OPEN) {
            try { activeUsers[user].send(JSON.stringify(data)); } catch(e) {}
        }
    }
}

function sendToUser(username, data) {
    if (activeUsers[username] && activeUsers[username].readyState === WebSocket.OPEN) {
        activeUsers[username].send(JSON.stringify(data));
    }
}

function broadcastUserList() {
    broadcast({ type: 'user_list', users: Object.keys(activeUsers) });
}

function saveMessage(from, to, message, fileData = null, fileName = null) {
    return new Promise((resolve, reject) => {
        db.run(
            INSERT INTO messages (from_user, to_user, message, file_data, file_name) VALUES (?, ?, ?, ?, ?),
            [from, to, message, fileData, fileName],
            function(err) { if (err) reject(err); else resolve(this.lastID); }
        );
    });
}

function getMessages(user1, user2) {
    return new Promise((resolve, reject) => {
        db.all(
            SELECT * FROM messages WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?) ORDER BY created_at ASC,
            [user1, user2, user2, user1],
            (err, rows) => { if (err) reject(err); else resolve(rows); }
        );
    });
}

function getUserChats(username) {
    return new Promise((resolve, reject) => {
        db.all(
            SELECT DISTINCT CASE WHEN from_user = ? THEN to_user ELSE from_user END as chat_user FROM messages WHERE from_user = ? OR to_user = ?,
            [username, username, username],
            (err, rows) => { if (err) reject(err); else resolve(rows); }
        );
    });
}

function getUserProfile(username) {
    return new Promise((resolve, reject) => {
        db.get(SELECT username, display_name, bio, avatar FROM users WHERE username = ?, [username], (err, row) => {
            if (err) reject(err);
            else resolve(row || { username, display_name: username, bio: '', avatar: '👤' });
        });
    });
}

function updateUserProfile(username, data) {
    return new Promise((resolve, reject) => {
